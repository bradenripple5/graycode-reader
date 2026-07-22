#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <opencv2/opencv.hpp>

namespace {

struct Options {
  int camera = 0;
  bool cameraSpecified = false;
  int width = 1280;
  int height = 720;
  int downscale = 640;
  int centerXPercent = 50;
  int centerYPercent = 50;
  int windowWidthPercent = 60;
  int windowHeightPercent = 10;
  int gapDistance = 72;
  int threshold = 140;
  int edgeStrength = 36;
  double fps = 0.0;
  double processFps = 20.0;
  bool projectionMode = false;
  bool grayDirection = true;
  bool edgeMarker = true;
  bool noWindow = false;
};

struct RotatedRect {
  double cx = 0.0;
  double cy = 0.0;
  double w = 0.0;
  double h = 0.0;
};

struct RowRun {
  double py = 0.0;
  double xStart = 0.0;
  double xEnd = 0.0;
  double length = 0.0;
};

struct Band {
  double start = 0.0;
  double end = 0.0;
  double center = 0.0;
  double xStart = 0.0;
  double xEnd = 0.0;
  double length = 0.0;
  double xStartSpread = 0.0;
  double xEndSpread = 0.0;
};

struct GrayRun {
  double sum = 0.0;
  int count = 0;
  double mean = 0.0;
};

struct GrayDirection {
  double angle = 0.0;
  double dx = 0.0;
  double dy = 0.0;
  int score = 0;
  int votes = 0;
  std::string sequence = "n/a";
};

struct AngleScore {
  double angle = 0.0;
  double score = 0.0;
  std::vector<Band> bands;
  std::optional<double> medianGap;
  bool singleLine = false;
};

struct GreenMarker {
  bool found = false;
  int count = 0;
  double cx = 0.0;
  double cy = 0.0;
};

struct EdgeMarkerResult {
  bool fit = false;
  double normalAngle = 0.0;
  double lineAngle = 0.0;
  double upAngle = 0.0;
  double coherence = 0.0;
  int edgeCount = 0;
  GreenMarker marker;
  bool direction = false;
};

struct Analysis {
  cv::Mat display;
  RotatedRect rect;
  std::optional<AngleScore> line;
  std::optional<GrayDirection> gray;
  std::optional<EdgeMarkerResult> edgeMarker;
  std::optional<double> outputAngle;
  long elapsedMs = 0;
};

struct AnalyzerState {
  double windowAngle = 0.0;
  bool angleLocked = false;
};

double normalizeDeg(double value) {
  double result = std::fmod(value, 360.0);
  if (result < 0.0) result += 360.0;
  return result;
}

double vectorAngleDeg(double dx, double dy) {
  return normalizeDeg(std::atan2(-dy, dx) * 180.0 / CV_PI);
}

double grayAt(const cv::Mat& bgr, int x, int y) {
  const cv::Vec3b pixel = bgr.at<cv::Vec3b>(y, x);
  return pixel[2] * 0.299 + pixel[1] * 0.587 + pixel[0] * 0.114;
}

bool rectPoint(const cv::Mat& image, const RotatedRect& rect, double ux, double uy, double vx, double vy,
               double px, double py, int& x, int& y) {
  x = static_cast<int>(std::round(rect.cx + ux * px + vx * py));
  y = static_cast<int>(std::round(rect.cy + uy * px + vy * py));
  return x >= 0 && x < image.cols && y >= 0 && y < image.rows;
}

// Builds a 0/255 mask over the given sub-rect matching the original per-pixel
// isGreenPixel() rule (g>=90 && g>=1.35r && g>=1.35b), fully vectorized instead
// of one .at<Vec3b>() call per pixel per neighbor check.
cv::Mat computeGreenMask(const cv::Mat& bgr, const cv::Rect& roi) {
  cv::Mat sub = bgr(roi);
  std::vector<cv::Mat> channels;
  cv::split(sub, channels);  // 0=B, 1=G, 2=R

  cv::Mat gF, rF, bF;
  channels[1].convertTo(gF, CV_32F);
  channels[2].convertTo(rF, CV_32F);
  channels[0].convertTo(bF, CV_32F);

  cv::Mat condG = gF >= 90.0f;
  cv::Mat condR = gF >= rF * 1.35f;
  cv::Mat condB = gF >= bF * 1.35f;

  cv::Mat mask;
  cv::bitwise_and(condG, condR, mask);
  cv::bitwise_and(mask, condB, mask);
  return mask;  // CV_8U, 255 where green
}

// "Touches green" = any green pixel within the 3x3 neighborhood, which is
// exactly a 3x3 dilation of the green mask (dilation is a vectorized OpenCV
// primitive, so this replaces 9 per-pixel isGreenPixel checks per pixel).
cv::Mat dilateGreenMask(const cv::Mat& greenMask) {
  static const cv::Mat kernel = cv::getStructuringElement(cv::MORPH_RECT, {3, 3});
  cv::Mat dilated;
  cv::dilate(greenMask, dilated, kernel);
  return dilated;
}

GreenMarker detectGreenMarkerFromMask(const cv::Mat& greenMask, int left, int top) {
  GreenMarker marker;
  // The original sampled every 2nd row/col (~1/4 the dense pixel count), so
  // the "found" threshold is scaled up to match the same physical blob size
  // now that we're testing every pixel via the dense mask.
  constexpr int kDenseFoundThreshold = 48;
  marker.count = cv::countNonZero(greenMask);
  if (marker.count < kDenseFoundThreshold) return marker;

  const cv::Moments m = cv::moments(greenMask, true);
  if (m.m00 <= 0.0) return marker;

  marker.found = true;
  marker.cx = left + m.m10 / m.m00;
  marker.cy = top + m.m01 / m.m00;
  return marker;
}

std::optional<EdgeMarkerResult> analyzeEdgeMarker(const cv::Mat& image, const RotatedRect& rect, int edgeStrength) {
  const int left = std::max(1, static_cast<int>(std::round(rect.cx - rect.w / 2.0)));
  const int right = std::min(image.cols - 2, static_cast<int>(std::round(rect.cx + rect.w / 2.0)));
  const int top = std::max(1, static_cast<int>(std::round(rect.cy - rect.h / 2.0)));
  const int bottom = std::min(image.rows - 2, static_cast<int>(std::round(rect.cy + rect.h / 2.0)));
  if (right <= left || bottom <= top) return std::nullopt;

  EdgeMarkerResult result;
  const cv::Rect roi(left, top, right - left + 1, bottom - top + 1);

  // left/top/right/bottom are clamped so left-1/top-1 >= 0 and right+1/bottom+1
  // are in-bounds (see the max(1,...)/min(cols-2,...) clamps above), so this
  // padded crop always has real neighbor pixels on every side of the ROI,
  // so cropping first (rather than running Sobel over the whole frame) keeps the
  // work proportional to the detection window, not the full frame.
  const cv::Rect paddedRoi(left - 1, top - 1, roi.width + 2, roi.height + 2);
  cv::Mat paddedBgr = image(paddedRoi);

  // cv::COLOR_BGR2GRAY uses the same 0.299R + 0.587G + 0.114B weights as
  // grayAt(), computed once for the small padded crop instead of per-pixel.
  cv::Mat gray;
  cv::cvtColor(paddedBgr, gray, cv::COLOR_BGR2GRAY);

  // cv::Sobel with ksize=3 applies the exact same unnormalized [-1,0,1;-2,0,2;-1,0,1]
  // / [-1,-2,-1;0,0,0;1,2,1] kernels as the manual gx/gy math below, but as one
  // vectorized pass rather than 8 grayAt() calls per pixel. The outermost ring
  // of the padded crop may use border-reflected values internally, but we only
  // read the interior below, which is fully determined by real neighbor pixels.
  cv::Mat gxPadded, gyPadded;
  cv::Sobel(gray, gxPadded, CV_32F, 1, 0, 3);
  cv::Sobel(gray, gyPadded, CV_32F, 0, 1, 3);

  const cv::Rect interior(1, 1, roi.width, roi.height);
  cv::Mat gxRoi = gxPadded(interior);
  cv::Mat gyRoi = gyPadded(interior);
  cv::Mat mag2 = gxRoi.mul(gxRoi) + gyRoi.mul(gyRoi);

  const cv::Mat greenMask = computeGreenMask(image, roi);  // unpadded ROI
  result.marker = detectGreenMarkerFromMask(greenMask, left, top);
  const cv::Mat touchesGreen = dilateGreenMask(greenMask);

  const double minMag2 = static_cast<double>(edgeStrength) * edgeStrength;
  cv::Mat strongEnough = mag2 >= static_cast<float>(minMag2);
  cv::Mat validMask;
  cv::bitwise_and(strongEnough, ~touchesGreen, validMask);

  result.edgeCount = cv::countNonZero(validMask);
  if (result.edgeCount < 4) return result;

  cv::Mat validF;
  validMask.convertTo(validF, CV_32F, 1.0 / 255.0);
  const double a = cv::sum(gxRoi.mul(gxRoi).mul(validF))[0];
  const double b = cv::sum(gxRoi.mul(gyRoi).mul(validF))[0];
  const double c = cv::sum(gyRoi.mul(gyRoi).mul(validF))[0];
  const double totalMag2 = cv::sum(mag2.mul(validF))[0];

  if (totalMag2 <= 0.0) return result;

  result.fit = true;
  result.normalAngle = normalizeDeg(0.5 * std::atan2(2.0 * b, a - c) * 180.0 / CV_PI);
  result.lineAngle = std::fmod(normalizeDeg(result.normalAngle + 90.0), 180.0);
  const double trace = a + c;
  const double root = std::sqrt(std::max(0.0, (a - c) * (a - c) + 4.0 * b * b));
  result.coherence = trace > 0.0 ? root / trace : 0.0;

  if (result.marker.found) {
    const double normalRad = result.normalAngle * CV_PI / 180.0;
    const double nx = std::cos(normalRad);
    const double ny = std::sin(normalRad);
    const double vx = result.marker.cx - rect.cx;
    const double vy = result.marker.cy - rect.cy;
    const double dot = vx * nx + vy * ny;
    result.upAngle = normalizeDeg(result.normalAngle + (dot < 0.0 ? 180.0 : 0.0));
    result.direction = true;
  }

  return result;
}

std::vector<double> smoothBins(const std::vector<double>& values, int radius) {
  std::vector<double> out(values.size(), 0.0);
  for (size_t i = 0; i < values.size(); ++i) {
    double sum = 0.0;
    int count = 0;
    const int start = std::max(0, static_cast<int>(i) - radius);
    const int end = std::min(static_cast<int>(values.size()) - 1, static_cast<int>(i) + radius);
    for (int j = start; j <= end; ++j) {
      sum += values[j];
      count++;
    }
    out[i] = count ? sum / count : 0.0;
  }
  return out;
}

std::optional<double> median(std::vector<double> values) {
  if (values.empty()) return std::nullopt;
  std::sort(values.begin(), values.end());
  return values[values.size() / 2];
}

std::vector<Band> detectBands(const std::vector<double>& profile) {
  std::vector<Band> bands;
  int start = -1;
  for (int i = 0; i < static_cast<int>(profile.size()); ++i) {
    const bool active = profile[i] > 0.18;
    if (active && start < 0) start = i;
    if ((!active || i == static_cast<int>(profile.size()) - 1) && start >= 0) {
      const int end = active && i == static_cast<int>(profile.size()) - 1 ? i : i - 1;
      if (end - start >= 2) {
        double weighted = 0.0;
        double total = 0.0;
        for (int j = start; j <= end; ++j) {
          weighted += j * profile[j];
          total += profile[j];
        }
        Band band;
        band.start = start;
        band.end = end;
        band.center = total ? weighted / total : (start + end) / 2.0;
        bands.push_back(band);
      }
      start = -1;
    }
  }
  return bands;
}

AngleScore scoreProjectionAngle(const cv::Mat& image, const RotatedRect& rect, double angleDeg,
                                int expectedGap, int threshold) {
  const double a = angleDeg * CV_PI / 180.0;
  const double ux = std::cos(a);
  const double uy = std::sin(a);
  const double vx = -uy;
  const double vy = ux;
  const int bins = std::max(4, static_cast<int>(std::round(rect.h)));
  std::vector<double> counts(bins, 0.0);
  std::vector<double> totals(bins, 0.0);

  for (double py = -rect.h / 2.0; py <= rect.h / 2.0; py += 3.0) {
    const int bin = std::clamp(static_cast<int>(std::round(py + rect.h / 2.0)), 0, bins - 1);
    for (double px = -rect.w / 2.0; px <= rect.w / 2.0; px += 3.0) {
      int x = 0;
      int y = 0;
      if (!rectPoint(image, rect, ux, uy, vx, vy, px, py, x, y)) continue;
      totals[bin]++;
      if (grayAt(image, x, y) < threshold) counts[bin]++;
    }
  }

  std::vector<double> density(bins, 0.0);
  for (int i = 0; i < bins; ++i) density[i] = totals[i] ? counts[i] / totals[i] : 0.0;
  const std::vector<double> profile = smoothBins(density, 2);
  std::vector<Band> bands = detectBands(profile);

  AngleScore result;
  result.angle = angleDeg;
  result.bands = bands;
  result.singleLine = bands.size() == 1;
  if (bands.empty()) return result;

  std::vector<double> gaps;
  for (size_t i = 1; i < bands.size(); ++i) gaps.push_back(bands[i].center - bands[i - 1].center);
  result.medianGap = median(gaps);
  const double gapError = result.medianGap ? std::abs(*result.medianGap - expectedGap) / std::max(1, expectedGap) : 0.7;
  const double gapScore = std::max(0.0, 1.0 - gapError);
  double blackPeaks = 0.0;
  for (const Band& band : bands) {
    const int idx = std::clamp(static_cast<int>(std::round(band.center)), 0, static_cast<int>(profile.size()) - 1);
    blackPeaks += profile[idx];
  }
  blackPeaks /= bands.size();
  const double lineCountScore = std::min(1.0, static_cast<double>(bands.size()) / 4.0);
  result.score = gapScore * 0.55 + blackPeaks * 0.25 + lineCountScore * 0.2;
  return result;
}

std::optional<RowRun> longestBlackRunOnRow(const cv::Mat& image, const RotatedRect& rect,
                                           double ux, double uy, double vx, double vy,
                                           double py, int threshold) {
  std::optional<RowRun> best;
  std::optional<double> currentStart;
  double currentEnd = 0.0;
  constexpr double step = 3.0;

  for (double px = -rect.w / 2.0; px <= rect.w / 2.0; px += step) {
    int x = 0;
    int y = 0;
    if (!rectPoint(image, rect, ux, uy, vx, vy, px, py, x, y)) continue;
    const bool isBlack = grayAt(image, x, y) < threshold;
    if (isBlack) {
      if (!currentStart) currentStart = px;
      currentEnd = px;
    } else if (currentStart) {
      const double length = currentEnd - *currentStart + step;
      if (!best || length > best->length) best = RowRun{py, *currentStart, currentEnd, length};
      currentStart.reset();
    }
  }

  if (currentStart) {
    const double length = currentEnd - *currentStart + step;
    if (!best || length > best->length) best = RowRun{py, *currentStart, currentEnd, length};
  }
  return best;
}

double whiteGapRatioBetweenBands(const cv::Mat& image, const RotatedRect& rect,
                                 double ux, double uy, double vx, double vy,
                                 const Band& a, const Band& b, int threshold) {
  const double y0 = a.end - rect.h / 2.0;
  const double y1 = b.start - rect.h / 2.0;
  if (y1 <= y0 + 2.0) return 0.0;

  const double xStart = std::max(a.xStart, b.xStart);
  const double xEnd = std::min(a.xEnd, b.xEnd);
  int white = 0;
  int total = 0;
  for (double py = y0 + 3.0; py < y1; py += 3.0) {
    for (double px = xStart; px <= xEnd; px += 6.0) {
      int x = 0;
      int y = 0;
      if (!rectPoint(image, rect, ux, uy, vx, vy, px, py, x, y)) continue;
      if (grayAt(image, x, y) >= threshold) white++;
      total++;
    }
  }
  return total ? static_cast<double>(white) / total : 0.0;
}

AngleScore scoreProbeAngle(const cv::Mat& image, const RotatedRect& rect, double angleDeg,
                           int expectedGap, int threshold) {
  const double a = angleDeg * CV_PI / 180.0;
  const double ux = std::cos(a);
  const double uy = std::sin(a);
  const double vx = -uy;
  const double vy = ux;
  constexpr double stepY = 2.0;
  const double minSpan = rect.w * 0.72;
  std::vector<RowRun> rows;

  for (double py = -rect.h / 2.0; py <= rect.h / 2.0; py += stepY) {
    auto run = longestBlackRunOnRow(image, rect, ux, uy, vx, vy, py, threshold);
    if (run && run->length >= minSpan) rows.push_back(*run);
  }

  std::vector<std::vector<RowRun>> grouped;
  std::vector<RowRun> current;
  for (const RowRun& row : rows) {
    if (current.empty() || row.py <= current.back().py + stepY * 1.5) {
      current.push_back(row);
    } else {
      if (current.size() >= 2) grouped.push_back(current);
      current = {row};
    }
  }
  if (current.size() >= 2) grouped.push_back(current);

  std::vector<Band> lineBands;
  for (const auto& group : grouped) {
    std::vector<double> starts;
    std::vector<double> ends;
    std::vector<double> lengths;
    std::vector<double> centers;
    for (const RowRun& row : group) {
      starts.push_back(row.xStart);
      ends.push_back(row.xEnd);
      lengths.push_back(row.length);
      centers.push_back(row.py);
    }
    const auto startRange = std::minmax_element(starts.begin(), starts.end());
    const auto endRange = std::minmax_element(ends.begin(), ends.end());
    const auto centerRange = std::minmax_element(centers.begin(), centers.end());
    const double count = static_cast<double>(group.size());
    Band band;
    band.start = *centerRange.first + rect.h / 2.0;
    band.end = *centerRange.second + rect.h / 2.0;
    band.center = std::accumulate(centers.begin(), centers.end(), 0.0) / count + rect.h / 2.0;
    band.xStart = std::accumulate(starts.begin(), starts.end(), 0.0) / count;
    band.xEnd = std::accumulate(ends.begin(), ends.end(), 0.0) / count;
    band.length = std::accumulate(lengths.begin(), lengths.end(), 0.0) / count;
    band.xStartSpread = *startRange.second - *startRange.first;
    band.xEndSpread = *endRange.second - *endRange.first;
    lineBands.push_back(band);
  }
  std::sort(lineBands.begin(), lineBands.end(), [](const Band& aBand, const Band& bBand) {
    return aBand.center < bBand.center;
  });

  AngleScore result;
  result.angle = angleDeg;
  result.bands = lineBands;
  result.singleLine = lineBands.size() == 1;
  if (lineBands.size() < 2) return result;

  const double endpointTolerance = std::max(8.0, rect.w * 0.06);
  std::optional<std::array<Band, 2>> bestPair;
  double bestScore = 0.0;
  std::optional<double> bestGap;

  for (size_t i = 0; i < lineBands.size(); ++i) {
    for (size_t j = i + 1; j < lineBands.size(); ++j) {
      const Band& first = lineBands[i];
      const Band& second = lineBands[j];
      const double gap = second.center - first.center;
      const double startDelta = std::abs(first.xStart - second.xStart);
      const double endDelta = std::abs(first.xEnd - second.xEnd);
      const double internalSpread = (first.xStartSpread + first.xEndSpread + second.xStartSpread + second.xEndSpread) / 2.0;
      const double spanScore = std::min(1.0, (first.length / rect.w + second.length / rect.w) / 2.0);
      const double endpointScore = std::max(0.0, 1.0 - (startDelta + endDelta) / (2.0 * endpointTolerance));
      const double internalScore = std::max(0.0, 1.0 - internalSpread / (2.0 * endpointTolerance));
      const double gapScore = std::max(0.0, 1.0 - std::abs(gap - expectedGap) / std::max(1.0, expectedGap * 0.5));
      const double whiteGapScore = whiteGapRatioBetweenBands(image, rect, ux, uy, vx, vy, first, second, threshold);
      const double score = endpointScore * 0.35 + internalScore * 0.20 + spanScore * 0.18 + gapScore * 0.10 + whiteGapScore * 0.17;
      if (score > bestScore) {
        bestScore = score;
        bestPair = std::array<Band, 2>{first, second};
        bestGap = gap;
      }
    }
  }

  result.score = bestScore;
  result.medianGap = bestGap;
  if (bestPair) result.bands = {(*bestPair)[0], (*bestPair)[1]};
  return result;
}

AngleScore scoreAngle(const cv::Mat& image, const RotatedRect& rect, double angleDeg,
                      int expectedGap, int threshold, bool projectionMode) {
  return projectionMode
      ? scoreProjectionAngle(image, rect, angleDeg, expectedGap, threshold)
      : scoreProbeAngle(image, rect, angleDeg, expectedGap, threshold);
}

std::vector<GrayRun> relativeGrayRuns(const std::vector<double>& samples) {
  std::vector<GrayRun> runs;
  constexpr double minRatio = 1.25;
  for (double value : samples) {
    if (runs.empty()) {
      runs.push_back({value, 1, value});
      continue;
    }
    GrayRun& last = runs.back();
    const double brighter = std::max(value, last.mean);
    const double darker = std::max(1.0, std::min(value, last.mean));
    if (brighter / darker < minRatio) {
      last.sum += value;
      last.count++;
      last.mean = last.sum / last.count;
    } else {
      runs.push_back({value, 1, value});
    }
  }

  std::vector<GrayRun> filtered;
  for (const GrayRun& run : runs) {
    if (run.count >= 2) filtered.push_back(run);
  }
  return filtered;
}

char grayRunLabel(const GrayRun& run) {
  if (run.mean >= 170.0) return 'L';
  if (run.mean <= 110.0) return 'D';
  return 'M';
}

std::optional<GrayDirection> grayDirectionForAngle(const cv::Mat& image, const RotatedRect& rect, double angleDeg) {
  const double a = angleDeg * CV_PI / 180.0;
  const double ux = std::cos(a);
  const double uy = std::sin(a);
  const double vx = -uy;
  const double vy = ux;
  const std::vector<double> columns = {-0.32, -0.16, 0.0, 0.16, 0.32};
  int score = 0;
  int votes = 0;
  std::string firstSequence;

  for (double column : columns) {
    const double px = column * rect.w;
    std::vector<double> samples;
    for (double py = -rect.h / 2.0; py <= rect.h / 2.0; py += 2.0) {
      int x = 0;
      int y = 0;
      if (!rectPoint(image, rect, ux, uy, vx, vy, px, py, x, y)) continue;
      samples.push_back(grayAt(image, x, y));
    }

    const auto runs = relativeGrayRuns(samples);
    if (runs.size() < 2) continue;
    std::string sequence;
    for (const GrayRun& run : runs) sequence.push_back(grayRunLabel(run));
    if (firstSequence.empty()) firstSequence = sequence;

    for (size_t i = 1; i < runs.size(); ++i) {
      const double previous = runs[i - 1].mean;
      const double current = runs[i].mean;
      const double brighter = std::max(previous, current);
      const double darker = std::max(1.0, std::min(previous, current));
      if (brighter / darker < 1.25) continue;
      score += previous > current ? 1 : -1;
      votes++;
    }
  }

  if (votes < 2 || score == 0) return std::nullopt;
  const int sign = score > 0 ? 1 : -1;
  const double dx = vx * sign;
  const double dy = vy * sign;
  return GrayDirection{vectorAngleDeg(dx, dy), dx, dy, score, votes, firstSequence.empty() ? "n/a" : firstSequence};
}

int centerVerticalLineIntersections(const cv::Mat& image, const RotatedRect& rect, int threshold) {
  const int x = std::clamp(static_cast<int>(std::round(rect.cx)), 0, image.cols - 1);
  const int yStart = std::clamp(static_cast<int>(std::round(rect.cy - rect.h / 2.0)), 0, image.rows - 1);
  const int yEnd = std::clamp(static_cast<int>(std::round(rect.cy + rect.h / 2.0)), 0, image.rows - 1);
  int runs = 0;
  int current = 0;
  for (int y = yStart; y <= yEnd; y += 2) {
    if (grayAt(image, x, y) < threshold) {
      current++;
    } else if (current > 0) {
      if (current >= 3) runs++;
      current = 0;
    }
  }
  if (current >= 3) runs++;
  return runs;
}

std::optional<AngleScore> analyzeAngle(const cv::Mat& image, const RotatedRect& rect,
                                       const Options& options, AnalyzerState& state) {
  const int centerIntersections = centerVerticalLineIntersections(image, rect, options.threshold);
  std::optional<AngleScore> best;
  auto consider = [&](double angle) {
    AngleScore candidate = scoreAngle(image, rect, std::fmod(normalizeDeg(angle), 180.0),
                                      options.gapDistance, options.threshold, options.projectionMode);
    if (!best || candidate.score > best->score) best = candidate;
  };

  if (state.angleLocked || centerIntersections > 0) {
    for (int offset = -18; offset <= 18; ++offset) consider(state.windowAngle + offset);
  } else {
    for (int offset = -10; offset <= 10; ++offset) consider(90.0 + offset);
  }

  if (!best || best->score < 0.25) {
    best.reset();
    for (int angle = 0; angle < 180; angle += 2) consider(angle);
  }
  if (!best || best->score <= 0.0) return std::nullopt;

  const double start = best->angle - 2.0;
  const double end = best->angle + 2.0;
  for (double angle = start; angle <= end; angle += 0.5) consider(angle);

  state.windowAngle = normalizeDeg(best->angle);
  state.angleLocked = true;
  return best;
}

Analysis processFrame(const cv::Mat& frame, const Options& options, AnalyzerState& state) {
  const auto start = std::chrono::steady_clock::now();

  Analysis result;

  // Define the detection window directly in the ORIGINAL camera frame.
  // The main algorithm will see only this crop, rather than a resized copy
  // of the entire frame.
  const double centerX = (options.centerXPercent / 100.0) * frame.cols;
  const double centerY = (options.centerYPercent / 100.0) * frame.rows;
  const double windowW = (options.windowWidthPercent / 100.0) * frame.cols;
  const double windowH = (options.windowHeightPercent / 100.0) * frame.rows;

  int sourceLeft = static_cast<int>(std::round(centerX - windowW / 2.0));
  int sourceTop = static_cast<int>(std::round(centerY - windowH / 2.0));
  int sourceRight = static_cast<int>(std::round(centerX + windowW / 2.0));
  int sourceBottom = static_cast<int>(std::round(centerY + windowH / 2.0));

  sourceLeft = std::clamp(sourceLeft, 0, frame.cols - 1);
  sourceTop = std::clamp(sourceTop, 0, frame.rows - 1);
  sourceRight = std::clamp(sourceRight, sourceLeft + 1, frame.cols);
  sourceBottom = std::clamp(sourceBottom, sourceTop + 1, frame.rows);

  const cv::Rect sourceRoi(sourceLeft, sourceTop,
                           sourceRight - sourceLeft,
                           sourceBottom - sourceTop);
  const cv::Mat cropped = frame(sourceRoi);

  // Preserve approximately the same analysis resolution as the old code.
  // Previously the whole frame was resized to options.downscale pixels wide,
  // then the ROI was extracted from that preview. Now only the ROI is resized.
  const double analysisScale = static_cast<double>(options.downscale) / frame.cols;
  const int analysisWidth = std::max(3, static_cast<int>(std::round(sourceRoi.width * analysisScale)));
  const int analysisHeight = std::max(3, static_cast<int>(std::round(sourceRoi.height * analysisScale)));

  cv::Mat analysisImage;
  cv::resize(cropped, analysisImage, cv::Size(analysisWidth, analysisHeight),
             0.0, 0.0, cv::INTER_AREA);

  // The analysis image is already exactly the detection window, so the local
  // rectangle covers the complete cropped image.
  const RotatedRect analysisRect{
      analysisImage.cols / 2.0,
      analysisImage.rows / 2.0,
      static_cast<double>(analysisImage.cols),
      static_cast<double>(analysisImage.rows),
  };

  if (options.edgeMarker) {
    result.edgeMarker = analyzeEdgeMarker(analysisImage, analysisRect, options.edgeStrength);
    if (result.edgeMarker && result.edgeMarker->fit) {
      result.outputAngle = result.edgeMarker->direction
                               ? result.edgeMarker->upAngle
                               : result.edgeMarker->lineAngle;
      state.windowAngle = result.edgeMarker->lineAngle;
      state.angleLocked = true;
    }
  } else {
    result.line = analyzeAngle(analysisImage, analysisRect, options, state);
    if (result.line) {
      result.outputAngle = result.line->angle;
      if (options.grayDirection) {
        result.gray = grayDirectionForAngle(analysisImage, analysisRect, result.line->angle);
        if (result.gray) result.outputAngle = result.gray->angle;
      }
    }
  }

  // Build the full preview only when it is actually needed for display.
  // This keeps --no-window from paying for a full-frame resize and clone.
  const double displayScale = static_cast<double>(options.downscale) / frame.cols;
  const int displayHeight = std::max(1, static_cast<int>(std::round(frame.rows * displayScale)));

  result.rect = {
      sourceRoi.x * displayScale + sourceRoi.width * displayScale / 2.0,
      sourceRoi.y * displayScale + sourceRoi.height * displayScale / 2.0,
      sourceRoi.width * displayScale,
      sourceRoi.height * displayScale,
  };

  if (!options.noWindow) {
    cv::resize(frame, result.display, cv::Size(options.downscale, displayHeight),
               0.0, 0.0, cv::INTER_AREA);

    // Marker coordinates were measured in the cropped analysis image. Convert
    // them back into preview coordinates for drawing.
    if (result.edgeMarker && result.edgeMarker->marker.found) {
      const double localScaleX = result.rect.w / analysisImage.cols;
      const double localScaleY = result.rect.h / analysisImage.rows;
      const double displayLeft = result.rect.cx - result.rect.w / 2.0;
      const double displayTop = result.rect.cy - result.rect.h / 2.0;
      result.edgeMarker->marker.cx = displayLeft + result.edgeMarker->marker.cx * localScaleX;
      result.edgeMarker->marker.cy = displayTop + result.edgeMarker->marker.cy * localScaleY;
    }
  }

  result.elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start).count();
  return result;
}

void drawRotatedRect(cv::Mat& frame, const RotatedRect& rect, double angleDeg, cv::Scalar color) {
  const double a = angleDeg * CV_PI / 180.0;
  const double ux = std::cos(a);
  const double uy = std::sin(a);
  const double vx = -uy;
  const double vy = ux;
  const std::array<cv::Point2d, 4> local = {{
      {-rect.w / 2.0, -rect.h / 2.0},
      {rect.w / 2.0, -rect.h / 2.0},
      {rect.w / 2.0, rect.h / 2.0},
      {-rect.w / 2.0, rect.h / 2.0},
  }};
  std::vector<cv::Point> points;
  for (const auto& p : local) {
    points.push_back({static_cast<int>(std::round(rect.cx + ux * p.x + vx * p.y)),
                      static_cast<int>(std::round(rect.cy + uy * p.x + vy * p.y))});
  }
  cv::polylines(frame, points, true, color, 2, cv::LINE_AA);
}

void drawArrowHead(cv::Mat& frame, cv::Point2f tip, cv::Point2f dir, double head, cv::Scalar color) {
  const double angle = std::atan2(dir.y, dir.x);
  const double halfHead = head * 0.45;
  std::vector<cv::Point> tri = {
      tip,
      {static_cast<int>(std::round(tip.x - dir.x * head - std::cos(angle + CV_PI / 2.0) * halfHead)),
       static_cast<int>(std::round(tip.y - dir.y * head - std::sin(angle + CV_PI / 2.0) * halfHead))},
      {static_cast<int>(std::round(tip.x - dir.x * head + std::cos(angle + CV_PI / 2.0) * halfHead)),
       static_cast<int>(std::round(tip.y - dir.y * head + std::sin(angle + CV_PI / 2.0) * halfHead))},
  };
  cv::fillConvexPoly(frame, tri, color, cv::LINE_AA);
}

void drawOverlay(cv::Mat& frame, const Analysis& result, double windowAngle, bool projectionMode) {
  if (result.edgeMarker) {
    const EdgeMarkerResult& edge = *result.edgeMarker;
    const cv::Scalar rectColor = edge.fit ? cv::Scalar(118, 230, 0) : cv::Scalar(82, 82, 255);
    cv::rectangle(frame,
                  {static_cast<int>(std::round(result.rect.cx - result.rect.w / 2.0)),
                   static_cast<int>(std::round(result.rect.cy - result.rect.h / 2.0))},
                  {static_cast<int>(std::round(result.rect.cx + result.rect.w / 2.0)),
                   static_cast<int>(std::round(result.rect.cy + result.rect.h / 2.0))},
                  rectColor, 2, cv::LINE_AA);

    const cv::Point2f center(static_cast<float>(result.rect.cx), static_cast<float>(result.rect.cy));
    if (edge.fit) {
      const double lineRad = edge.lineAngle * CV_PI / 180.0;
      const cv::Point2f lineDir(static_cast<float>(std::cos(lineRad)), static_cast<float>(std::sin(lineRad)));
      const float lineLen = static_cast<float>(std::hypot(result.rect.w, result.rect.h) * 0.45);
      cv::line(frame, center - lineDir * lineLen, center + lineDir * lineLen, {255, 255, 0}, 5, cv::LINE_AA);

      const double normalRad = edge.normalAngle * CV_PI / 180.0;
      const cv::Point2f normalDir(static_cast<float>(std::cos(normalRad)), static_cast<float>(std::sin(normalRad)));
      const float normalLen = static_cast<float>(std::min(result.rect.w, result.rect.h) * 0.35);
      cv::line(frame, center, center + normalDir * normalLen, {255, 102, 255}, 4, cv::LINE_AA);

      if (edge.direction) {
        const double upRad = edge.upAngle * CV_PI / 180.0;
        const cv::Point2f upDir(static_cast<float>(std::cos(upRad)), static_cast<float>(std::sin(upRad)));
        const double arrowLen = std::min(result.rect.w, result.rect.h) * 0.42;
        const double head = std::max(24.0, arrowLen * 0.30);
        const cv::Point2f tip = center + upDir * static_cast<float>(arrowLen);
        const cv::Point2f shaftEnd = tip - upDir * static_cast<float>(head * 0.55);
        cv::line(frame, center, shaftEnd, {0, 0, 0}, 18, cv::LINE_AA);
        cv::line(frame, center, shaftEnd, {118, 230, 0}, 10, cv::LINE_AA);
        drawArrowHead(frame, tip, upDir, head, {0, 0, 0});
        drawArrowHead(frame, tip, upDir, head * 0.78, {118, 230, 0});
        cv::putText(frame, "UP", tip + cv::Point2f(10.0f, 10.0f), cv::FONT_HERSHEY_SIMPLEX,
                    0.85, {0, 0, 0}, 6, cv::LINE_AA);
        cv::putText(frame, "UP", tip + cv::Point2f(10.0f, 10.0f), cv::FONT_HERSHEY_SIMPLEX,
                    0.85, {118, 230, 0}, 2, cv::LINE_AA);
      }
    }

    if (edge.marker.found) {
      cv::circle(frame, {static_cast<int>(std::round(edge.marker.cx)), static_cast<int>(std::round(edge.marker.cy))},
                 7, {114, 255, 0}, cv::FILLED, cv::LINE_AA);
    }

    std::ostringstream label;
    label << "edge-marker angle=" << (result.outputAngle ? std::to_string(*result.outputAngle) : "n/a")
          << " line=" << (edge.fit ? std::to_string(edge.lineAngle) : "n/a")
          << " normal=" << (edge.fit ? std::to_string(edge.normalAngle) : "n/a")
          << " coherence=" << edge.coherence
          << " edges=" << edge.edgeCount
          << " marker=" << (edge.marker.found ? std::to_string(edge.marker.count) : "0");
    cv::putText(frame, label.str(), {12, 24}, cv::FONT_HERSHEY_SIMPLEX, 0.55, {255, 255, 255}, 2, cv::LINE_AA);
    return;
  }

  drawRotatedRect(frame, result.rect, windowAngle, result.line ? cv::Scalar(118, 230, 0) : cv::Scalar(82, 82, 255));
  if (!result.line) return;

  const double a = result.line->angle * CV_PI / 180.0;
  const double ux = std::cos(a);
  const double uy = std::sin(a);
  const double vx = -uy;
  const double vy = ux;
  const cv::Point2f center(static_cast<float>(result.rect.cx), static_cast<float>(result.rect.cy));

  for (const Band& band : result.line->bands) {
    const double py = band.center - result.rect.h / 2.0;
    cv::Point2f p1(static_cast<float>(result.rect.cx - ux * result.rect.w / 2.0 + vx * py),
                   static_cast<float>(result.rect.cy - uy * result.rect.w / 2.0 + vy * py));
    cv::Point2f p2(static_cast<float>(result.rect.cx + ux * result.rect.w / 2.0 + vx * py),
                   static_cast<float>(result.rect.cy + uy * result.rect.w / 2.0 + vy * py));
    cv::line(frame, p1, p2, {59, 235, 255}, 2, cv::LINE_AA);
  }

  if (!projectionMode) {
    for (int i = 0; i < 5; ++i) {
      const double px = ((i + 0.5) / 5.0 - 0.5) * result.rect.w * 0.86;
      cv::Point2f p1(static_cast<float>(result.rect.cx + ux * px - vx * result.rect.h / 2.0),
                     static_cast<float>(result.rect.cy + uy * px - vy * result.rect.h / 2.0));
      cv::Point2f p2(static_cast<float>(result.rect.cx + ux * px + vx * result.rect.h / 2.0),
                     static_cast<float>(result.rect.cy + uy * px + vy * result.rect.h / 2.0));
      cv::line(frame, p1, p2, {255, 255, 255}, 1, cv::LINE_AA);
    }
  }

  cv::Point2f gapDelta(static_cast<float>(vx * result.rect.h * 0.42), static_cast<float>(vy * result.rect.h * 0.42));
  cv::line(frame, center, center + gapDelta, {255, 102, 255}, 2, cv::LINE_AA);

  if (result.gray) {
    const double arrowLen = result.rect.h * 0.48;
    const double head = std::max(34.0, result.rect.h * 0.24);
    const cv::Point2f dir(static_cast<float>(result.gray->dx), static_cast<float>(result.gray->dy));
    const cv::Point2f p1 = center - dir * static_cast<float>(arrowLen);
    const cv::Point2f p2 = center + dir * static_cast<float>(arrowLen);
    const cv::Point2f shaftEnd = p2 - dir * static_cast<float>(head * 0.55);
    cv::line(frame, p1, shaftEnd, {216, 79, 255}, 18, cv::LINE_AA);
    drawArrowHead(frame, p2, dir, head, {216, 79, 255});
  }

  std::ostringstream label;
  label << "angle=" << (result.outputAngle ? std::to_string(*result.outputAngle) : "n/a")
        << " line=" << result.line->angle
        << " score=" << result.line->score
        << " bands=" << result.line->bands.size();
  cv::putText(frame, label.str(), {12, 24}, cv::FONT_HERSHEY_SIMPLEX, 0.55, {255, 255, 255}, 2, cv::LINE_AA);
}

void printUsage(const char* name) {
  std::cerr
      << "Usage: " << name << " [options]\n"
      << "  --camera N         V4L camera index (default: auto-run all detected cameras)\n"
      << "  --width N          capture width (default 1280)\n"
      << "  --height N         capture height (default 720)\n"
      << "  --fps N            requested camera FPS\n"
      << "  --process-fps N    processing FPS (default 20)\n"
      << "  --downscale N      processing width (default 640)\n"
      << "  --center-x N       window center X percent (default 50)\n"
      << "  --center-y N       window center Y percent (default 50)\n"
      << "  --window-width N   window width percent (default 60)\n"
      << "  --window-height N  window height percent (default 10)\n"
      << "  --gap-distance N   expected line gap in processed pixels (default 72)\n"
      << "  --threshold N      black threshold (default 140)\n"
      << "  --edge-strength N  Sobel edge threshold for edge-marker mode (default 36)\n"
      << "  --edge-marker      use black/white edge fit plus green marker direction (default)\n"
      << "  --legacy-lines     use older parallel-line scanner instead of edge-marker mode\n"
      << "  --projection-mode  use projection scoring fallback path\n"
      << "  --no-gray-direction  only report raw parallel-line angle\n"
      << "  --no-window        print only, do not open preview window\n";
}

bool parseArgs(int argc, char** argv, Options& options) {
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    auto readInt = [&](int& target) {
      if (i + 1 >= argc) return false;
      target = std::atoi(argv[++i]);
      return true;
    };
    auto readDouble = [&](double& target) {
      if (i + 1 >= argc) return false;
      target = std::atof(argv[++i]);
      return true;
    };
    if (arg == "--camera") {
      if (!readInt(options.camera)) return false;
      options.cameraSpecified = true;
    } else if (arg == "--width") {
      if (!readInt(options.width)) return false;
    } else if (arg == "--height") {
      if (!readInt(options.height)) return false;
    } else if (arg == "--fps") {
      if (!readDouble(options.fps)) return false;
    } else if (arg == "--process-fps") {
      if (!readDouble(options.processFps)) return false;
    } else if (arg == "--downscale") {
      if (!readInt(options.downscale)) return false;
    } else if (arg == "--center-x") {
      if (!readInt(options.centerXPercent)) return false;
    } else if (arg == "--center-y") {
      if (!readInt(options.centerYPercent)) return false;
    } else if (arg == "--window-width") {
      if (!readInt(options.windowWidthPercent)) return false;
    } else if (arg == "--window-height") {
      if (!readInt(options.windowHeightPercent)) return false;
    } else if (arg == "--gap-distance") {
      if (!readInt(options.gapDistance)) return false;
    } else if (arg == "--threshold") {
      if (!readInt(options.threshold)) return false;
    } else if (arg == "--edge-strength") {
      if (!readInt(options.edgeStrength)) return false;
    } else if (arg == "--edge-marker") {
      options.edgeMarker = true;
    } else if (arg == "--legacy-lines") {
      options.edgeMarker = false;
    } else if (arg == "--projection-mode") {
      options.projectionMode = true;
    } else if (arg == "--no-gray-direction") {
      options.grayDirection = false;
    } else if (arg == "--no-window") {
      options.noWindow = true;
    } else if (arg == "--help" || arg == "-h") {
      printUsage(argv[0]);
      std::exit(0);
    } else {
      std::cerr << "Unknown option: " << arg << "\n";
      return false;
    }
  }

  options.downscale = std::max(1, options.downscale);
  options.centerXPercent = std::clamp(options.centerXPercent, 0, 100);
  options.centerYPercent = std::clamp(options.centerYPercent, 0, 100);
  options.windowWidthPercent = std::clamp(options.windowWidthPercent, 10, 100);
  options.windowHeightPercent = std::clamp(options.windowHeightPercent, 3, 60);
  options.gapDistance = std::max(1, options.gapDistance);
  options.threshold = std::clamp(options.threshold, 0, 255);
  options.edgeStrength = std::clamp(options.edgeStrength, 1, 1024);
  options.processFps = std::max(0.0, options.processFps);
  return true;
}

std::atomic<bool> g_running{true};

void handleSignal(int) {
  g_running = false;
}

std::vector<int> detectCameraIndexes() {
  std::vector<int> cameras;
  const std::filesystem::path devDir("/dev");
  if (!std::filesystem::exists(devDir)) return cameras;

  for (const auto& entry : std::filesystem::directory_iterator(devDir)) {
    const std::string name = entry.path().filename().string();
    if (name.rfind("video", 0) != 0) continue;
    const std::string suffix = name.substr(5);
    if (suffix.empty() || !std::all_of(suffix.begin(), suffix.end(), ::isdigit)) continue;
    const int index = std::atoi(suffix.c_str());
    cv::VideoCapture test(index, cv::CAP_V4L2);
    if (!test.isOpened()) continue;
    cv::Mat frame;
    if (test.read(frame) && !frame.empty()) cameras.push_back(index);
  }

  std::sort(cameras.begin(), cameras.end());
  cameras.erase(std::unique(cameras.begin(), cameras.end()), cameras.end());
  return cameras;
}

std::string usbPortLabelForCamera(int cameraIndex) {
  namespace fs = std::filesystem;
  const fs::path devPath = fs::path("/dev") / ("video" + std::to_string(cameraIndex));
  std::error_code ec;
  const fs::path canonicalDev = fs::weakly_canonical(devPath, ec);
  if (ec) return "port unknown";

  const fs::path byPathDir("/dev/v4l/by-path");
  if (!fs::exists(byPathDir, ec)) return "port unknown";

  for (const auto& entry : fs::directory_iterator(byPathDir, ec)) {
    if (ec) break;
    const std::string name = entry.path().filename().string();
    if (name.find("video-index0") == std::string::npos) continue;
    const fs::path resolved = fs::weakly_canonical(entry.path(), ec);
    if (ec || resolved != canonicalDev) continue;

    const std::string marker = "usb-0:";
    const size_t start = name.find(marker);
    if (start == std::string::npos) return name;
    const size_t end = name.find(":1.0", start);
    if (end == std::string::npos) return name.substr(start);
    return name.substr(start, end - start);
  }

  return "port unknown";
}

int runCamera(Options options) {
  cv::VideoCapture cap(options.camera, cv::CAP_V4L2);
  if (!cap.isOpened()) {
    std::cerr << "Failed to open camera " << options.camera << "\n";
    return 1;
  }
  cap.set(cv::CAP_PROP_FRAME_WIDTH, options.width);
  cap.set(cv::CAP_PROP_FRAME_HEIGHT, options.height);
  cap.set(cv::CAP_PROP_FOURCC, cv::VideoWriter::fourcc('M', 'J', 'P', 'G'));
  if (options.fps > 0.0) cap.set(cv::CAP_PROP_FPS, options.fps);

  const std::string portLabel = usbPortLabelForCamera(options.camera);
  const std::string windowName = "parallel grayscale direction reader camera " + std::to_string(options.camera) + " " + portLabel;
  if (!options.noWindow) cv::namedWindow(windowName, cv::WINDOW_NORMAL);

  AnalyzerState state;
  auto nextFrameAt = std::chrono::steady_clock::now();
  int frameNo = 0;
  while (g_running) {
    const auto loopStart = std::chrono::steady_clock::now();
    cv::Mat frame;
    if (!cap.read(frame) || frame.empty()) {
      std::cerr << "camera=" << options.camera << "\tfailed to read frame\n";
      continue;
    }

    Analysis result = processFrame(frame, options, state);
    std::cout << "camera=" << options.camera
              << "\tframe=" << frameNo++
              << "\tangle=" << (result.outputAngle ? std::to_string(*result.outputAngle) : "n/a");
    if (options.edgeMarker) {
      const EdgeMarkerResult* edge = result.edgeMarker ? &*result.edgeMarker : nullptr;
      std::cout << "\tline=" << (edge && edge->fit ? std::to_string(edge->lineAngle) : "n/a")
                << "\tnormal=" << (edge && edge->fit ? std::to_string(edge->normalAngle) : "n/a")
                << "\tup=" << (edge && edge->direction ? std::to_string(edge->upAngle) : "n/a")
                << "\tedges=" << (edge ? std::to_string(edge->edgeCount) : "0")
                << "\tcoherence=" << (edge ? std::to_string(edge->coherence) : "0")
                << "\tmarker=" << (edge && edge->marker.found ? std::to_string(edge->marker.count) : "0");
    } else {
      std::cout << "\tline=" << (result.line ? std::to_string(result.line->angle) : "n/a")
                << "\tgap=" << (result.line && result.line->medianGap ? std::to_string(*result.line->medianGap) : "n/a")
                << "\tbands=" << (result.line ? std::to_string(result.line->bands.size()) : "0")
                << "\tscore=" << (result.line ? std::to_string(result.line->score) : "0")
                << "\tgray=" << (result.gray ? result.gray->sequence : "n/a");
    }
    std::cout << "\tms=" << result.elapsedMs << "\n";

    if (!options.noWindow) {
      drawOverlay(result.display, result, state.windowAngle, options.projectionMode);
      const std::string hud = "cam " + std::to_string(options.camera) + " " + portLabel;
      cv::rectangle(result.display, {0, 0}, {result.display.cols, 30}, {0, 0, 0}, cv::FILLED);
      cv::putText(result.display, hud, {12, 22}, cv::FONT_HERSHEY_SIMPLEX, 0.62, {255, 255, 255}, 2, cv::LINE_AA);
      cv::imshow(windowName, result.display);
      const int key = cv::waitKey(1);
      if (key == 27 || key == 'q' || key == 'Q') g_running = false;
      if (cv::getWindowProperty(windowName, cv::WND_PROP_VISIBLE) < 1.0) g_running = false;
    }

    if (options.processFps > 0.0) {
      const auto framePeriod = std::chrono::duration<double>(1.0 / options.processFps);
      nextFrameAt = std::max(nextFrameAt + std::chrono::duration_cast<std::chrono::steady_clock::duration>(framePeriod), loopStart);
      std::this_thread::sleep_until(nextFrameAt);
    }
  }
  cap.release();
  if (!options.noWindow) cv::destroyWindow(windowName);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  if (!parseArgs(argc, argv, options)) {
    printUsage(argv[0]);
    return 2;
  }

  std::signal(SIGINT, handleSignal);
  std::signal(SIGTERM, handleSignal);

  if (options.cameraSpecified) {
    return runCamera(options);
  }

  const std::vector<int> cameras = detectCameraIndexes();
  if (cameras.empty()) {
    std::cerr << "No usable /dev/video* cameras found\n";
    return 1;
  }

  std::cerr << "Auto-running cameras:";
  for (int camera : cameras) std::cerr << " " << camera;
  std::cerr << "\n";

  std::vector<std::thread> threads;
  for (int camera : cameras) {
    Options cameraOptions = options;
    cameraOptions.camera = camera;
    threads.emplace_back([cameraOptions]() mutable {
      runCamera(cameraOptions);
    });
  }

  for (auto& thread : threads) thread.join();
  if (!options.noWindow) cv::destroyAllWindows();
  return 0;
}
