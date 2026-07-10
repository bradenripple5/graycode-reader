#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <numeric>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <opencv2/opencv.hpp>

namespace {

constexpr int kAngleSlotCount = 20;
constexpr int kBestThresholdIterations = 6;

struct Options {
  int camera = 0;
  std::vector<int> cameras;
  int width = 1280;
  int height = 720;
  int downscale = 640;
  int expectedPairs = 10;
  int threshold = 128;
  double fps = 0.0;
  double processFps = 0.0;
  double exposure = std::numeric_limits<double>::quiet_NaN();
  double gain = std::numeric_limits<double>::quiet_NaN();
  double brightness = std::numeric_limits<double>::quiet_NaN();
  double contrast = std::numeric_limits<double>::quiet_NaN();
  int printEvery = 1;
  bool useThreshold = false;
  bool autoThreshold = false;
  bool bestThreshold = false;
  bool simpleCross = true;
  bool noWindow = false;
};

struct Marker {
  int id = -1;
  std::vector<cv::Point2f> corners;
  double area = 0.0;
};

struct Pair {
  int index = 0;
  Marker inner;
  Marker outer;
  cv::Point2f innerCenter;
  cv::Point2f outerCenter;
  double expectedAngle = 0.0;
};

struct Score {
  int pairCount = 0;
  int markerCount = 0;
  int expectedGap = 0;
  double area = 0.0;
};

struct ThresholdPass {
  int threshold = 0;
  std::vector<Marker> markers;
  Score score;
  std::vector<int> path;
};

struct CameraState {
  int index = 0;
  cv::VideoCapture cap;
  std::string windowName;
  int frameNo = 0;
  int lastCaptureFpsTrack = 0;
};

struct FrameResult {
  cv::Mat display;
  std::vector<Marker> markers;
  std::vector<Pair> pairs;
  std::optional<double> upAngle;
  std::string thresholdSummary;
  long elapsedMs = 0;
};

double normalizeDeg(double value) {
  double result = std::fmod(value, 360.0);
  if (result < 0.0) result += 360.0;
  return result;
}

cv::Point2f markerCenter(const Marker& marker) {
  cv::Point2f sum(0.0f, 0.0f);
  for (const auto& point : marker.corners) sum += point;
  return sum * (1.0f / static_cast<float>(marker.corners.size()));
}

int pairPartnerId(int id) {
  return (id % 2 == 1) ? id + 1 : id - 1;
}

std::optional<int> slotToEvenIndex(int slot, int total) {
  for (int i = 0; i < total; ++i) {
    if (std::floor((static_cast<double>(i) * kAngleSlotCount) / total) == slot) return i;
  }
  return std::nullopt;
}

double pairFixedAngle(const Pair& pair, int total) {
  auto evenIndex = slotToEvenIndex(pair.index, total);
  if (!evenIndex) return pair.expectedAngle;
  return normalizeDeg((static_cast<double>(*evenIndex) / total) * 360.0);
}

cv::Scalar bgrForIndex(int index) {
  static const std::vector<cv::Scalar> colors = {
    {40, 40, 255}, {0, 165, 255}, {0, 230, 255}, {80, 220, 80},
    {255, 220, 0}, {255, 120, 40}, {210, 80, 210}, {200, 80, 255}
  };
  return colors[static_cast<size_t>(index) % colors.size()];
}

cv::Mat applyIntensityThreshold(const cv::Mat& bgr, int threshold) {
  cv::Mat gray;
  cv::cvtColor(bgr, gray, cv::COLOR_BGR2GRAY);
  cv::Mat binary;
  cv::threshold(gray, binary, threshold, 255, cv::THRESH_BINARY);
  cv::Mat result;
  cv::cvtColor(binary, result, cv::COLOR_GRAY2BGR);
  return result;
}

int hammingDistance(const int bits[5][5]) {
  static const int ids[4][5] = {
    {1, 0, 0, 0, 0},
    {1, 0, 1, 1, 1},
    {0, 1, 0, 0, 1},
    {0, 1, 1, 1, 0},
  };
  int dist = 0;
  for (int i = 0; i < 5; ++i) {
    int minSum = 5;
    for (const auto& id : ids) {
      int sum = 0;
      for (int k = 0; k < 5; ++k) sum += bits[i][k] == id[k] ? 0 : 1;
      minSum = std::min(minSum, sum);
    }
    dist += minSum;
  }
  return dist;
}

void rotateBits(const int src[5][5], int dst[5][5]) {
  for (int i = 0; i < 5; ++i) {
    for (int j = 0; j < 5; ++j) {
      dst[i][j] = src[5 - j - 1][i];
    }
  }
}

int matToId(const int bits[5][5]) {
  int id = 0;
  for (int i = 0; i < 5; ++i) {
    id <<= 1;
    id |= bits[i][1];
    id <<= 1;
    id |= bits[i][3];
  }
  return id;
}

std::vector<cv::Point2f> rotateCorners(const std::vector<cv::Point2f>& corners, int rotation) {
  std::vector<cv::Point2f> result(4);
  for (int i = 0; i < 4; ++i) result[i] = corners[(i + rotation) % 4];
  return result;
}

std::optional<Marker> decodeJsArucoMarker(const cv::Mat& gray, const std::vector<cv::Point2f>& quad) {
  constexpr int warpSize = 49;
  constexpr int cell = warpSize / 7;
  const std::vector<cv::Point2f> dst = {
    {0.0f, 0.0f},
    {static_cast<float>(warpSize - 1), 0.0f},
    {static_cast<float>(warpSize - 1), static_cast<float>(warpSize - 1)},
    {0.0f, static_cast<float>(warpSize - 1)},
  };

  cv::Mat transform = cv::getPerspectiveTransform(quad, dst);
  cv::Mat warped;
  cv::warpPerspective(gray, warped, transform, cv::Size(warpSize, warpSize));
  cv::threshold(warped, warped, 125, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);

  const int minZero = (cell * cell) / 2;
  for (int i = 0; i < 7; ++i) {
    int inc = (i == 0 || i == 6) ? 1 : 6;
    for (int j = 0; j < 7; j += inc) {
      cv::Rect square(j * cell, i * cell, cell, cell);
      if (cv::countNonZero(warped(square)) > minZero) return std::nullopt;
    }
  }

  int bits[5][5] = {};
  for (int i = 0; i < 5; ++i) {
    for (int j = 0; j < 5; ++j) {
      cv::Rect square((j + 1) * cell, (i + 1) * cell, cell, cell);
      bits[i][j] = cv::countNonZero(warped(square)) > minZero ? 1 : 0;
    }
  }

  int rotations[4][5][5] = {};
  std::copy(&bits[0][0], &bits[0][0] + 25, &rotations[0][0][0]);
  int bestDistance = hammingDistance(rotations[0]);
  int bestRotation = 0;
  for (int i = 1; i < 4; ++i) {
    rotateBits(rotations[i - 1], rotations[i]);
    int distance = hammingDistance(rotations[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRotation = i;
    }
  }
  if (bestDistance != 0) return std::nullopt;

  Marker marker;
  marker.id = matToId(rotations[bestRotation]);
  marker.corners = rotateCorners(quad, (4 - bestRotation) % 4);
  marker.area = std::abs(cv::contourArea(marker.corners));
  return marker;
}

std::vector<cv::Point2f> orderQuadClockwise(std::vector<cv::Point2f> quad) {
  cv::Point2f center(0.0f, 0.0f);
  for (const auto& point : quad) center += point;
  center *= 0.25f;
  std::sort(quad.begin(), quad.end(), [center](const cv::Point2f& a, const cv::Point2f& b) {
    return std::atan2(a.y - center.y, a.x - center.x) < std::atan2(b.y - center.y, b.x - center.x);
  });
  auto topLeft = std::min_element(quad.begin(), quad.end(), [](const cv::Point2f& a, const cv::Point2f& b) {
    return (a.x + a.y) < (b.x + b.y);
  });
  std::rotate(quad.begin(), topLeft, quad.end());
  return quad;
}

std::vector<Marker> detectMarkers(const cv::Mat& frame) {
  cv::Mat gray;
  if (frame.channels() == 1) {
    gray = frame;
  } else {
    cv::cvtColor(frame, gray, cv::COLOR_BGR2GRAY);
  }

  cv::Mat binary;
  cv::adaptiveThreshold(gray, binary, 255, cv::ADAPTIVE_THRESH_GAUSSIAN_C, cv::THRESH_BINARY_INV, 11, 7);

  std::vector<std::vector<cv::Point>> contours;
  cv::findContours(binary, contours, cv::RETR_LIST, cv::CHAIN_APPROX_SIMPLE);

  std::vector<Marker> markers;
  const double minArea = frame.cols * frame.rows * 0.00008;
  for (const auto& contour : contours) {
    double area = std::abs(cv::contourArea(contour));
    if (area < minArea) continue;
    std::vector<cv::Point> approx;
    cv::approxPolyDP(contour, approx, cv::arcLength(contour, true) * 0.05, true);
    if (approx.size() != 4 || !cv::isContourConvex(approx)) continue;

    std::vector<cv::Point2f> quad;
    for (const auto& point : approx) quad.emplace_back(static_cast<float>(point.x), static_cast<float>(point.y));
    quad = orderQuadClockwise(std::move(quad));
    auto marker = decodeJsArucoMarker(gray, quad);
    if (marker) markers.push_back(*marker);
  }

  std::sort(markers.begin(), markers.end(), [](const Marker& a, const Marker& b) {
    return a.area > b.area;
  });

  std::vector<Marker> unique;
  std::set<int> seen;
  for (const auto& marker : markers) {
    if (seen.insert(marker.id).second) unique.push_back(marker);
  }
  return unique;
}

std::vector<Pair> findMarkerPairs(const std::vector<Marker>& markers) {
  std::map<int, Marker> byId;
  for (const auto& marker : markers) byId[marker.id] = marker;

  std::set<int> claimed;
  std::vector<Pair> pairs;
  for (const auto& marker : markers) {
    if (claimed.count(marker.id)) continue;
    int partnerId = pairPartnerId(marker.id);
    auto partnerIt = byId.find(partnerId);
    if (partnerIt == byId.end() || claimed.count(partnerId) || partnerId == marker.id) continue;

    claimed.insert(marker.id);
    claimed.insert(partnerId);
    const bool isOddFirst = marker.id % 2 == 1;
    Pair pair;
    pair.inner = isOddFirst ? marker : partnerIt->second;
    pair.outer = isOddFirst ? partnerIt->second : marker;
    pair.innerCenter = markerCenter(pair.inner);
    pair.outerCenter = markerCenter(pair.outer);
    pair.index = (pair.inner.id - 1) / 2;
    pair.expectedAngle = normalizeDeg((static_cast<double>(pair.index) / kAngleSlotCount) * 360.0);
    pairs.push_back(pair);
  }

  std::sort(pairs.begin(), pairs.end(), [](const Pair& a, const Pair& b) {
    return a.index < b.index;
  });
  return pairs;
}

std::optional<std::pair<cv::Point2f, std::vector<Pair>>> estimateRingPairs(const std::vector<Marker>& markers) {
  auto pairs = findMarkerPairs(markers);
  if (pairs.empty()) return std::nullopt;
  cv::Point2f center(0.0f, 0.0f);
  for (const auto& pair : pairs) center += (pair.innerCenter + pair.outerCenter) * 0.5f;
  center *= 1.0f / static_cast<float>(pairs.size());
  return std::make_pair(center, pairs);
}

std::optional<double> computeUpValue(const std::vector<Pair>& pairs, int expectedTotal) {
  double bestCosine = -2.0;
  std::optional<double> bestAngle;
  for (const auto& pair : pairs) {
    double dx = pair.outerCenter.x - pair.innerCenter.x;
    double dy = pair.outerCenter.y - pair.innerCenter.y;
    double len = std::hypot(dx, dy);
    if (len < 1e-9) continue;
    double dot = -dy;
    double cross = -dx;
    double cosine = std::clamp(dot / len, -1.0, 1.0);
    if (cosine > bestCosine) {
      bestCosine = cosine;
      double offset = std::atan2(cross, dot) * 180.0 / CV_PI;
      bestAngle = normalizeDeg(pairFixedAngle(pair, expectedTotal) + offset);
    }
  }
  return bestAngle;
}

double markerSetArea(const std::vector<Marker>& markers) {
  double total = 0.0;
  for (const auto& marker : markers) total += marker.area;
  return total;
}

Score scoreThresholdPass(const std::vector<Marker>& markers, const Options& options) {
  std::vector<Pair> pairs;
  if (options.simpleCross) {
    pairs = findMarkerPairs(markers);
  } else {
    auto fit = estimateRingPairs(markers);
    if (fit) pairs = fit->second;
  }
  return {
    static_cast<int>(pairs.size()),
    static_cast<int>(markers.size()),
    std::abs(options.expectedPairs - static_cast<int>(pairs.size())),
    markerSetArea(markers),
  };
}

bool betterPass(const ThresholdPass& a, const ThresholdPass& b) {
  if (a.score.pairCount != b.score.pairCount) return a.score.pairCount > b.score.pairCount;
  if (a.score.markerCount != b.score.markerCount) return a.score.markerCount > b.score.markerCount;
  if (a.score.expectedGap != b.score.expectedGap) return a.score.expectedGap < b.score.expectedGap;
  return a.score.area > b.score.area;
}

ThresholdPass detectThresholdPass(const cv::Mat& frame, int threshold, const Options& options) {
  auto thresholded = applyIntensityThreshold(frame, threshold);
  auto markers = detectMarkers(thresholded);
  return {threshold, markers, scoreThresholdPass(markers, options), {}};
}

std::vector<Marker> compileThresholdMarkers(const std::vector<ThresholdPass>& passes) {
  struct Entry {
    Marker marker;
    double bestArea = 0.0;
    int count = 0;
  };
  std::map<int, Entry> byId;
  for (const auto& pass : passes) {
    for (const auto& marker : pass.markers) {
      auto& entry = byId[marker.id];
      entry.count++;
      if (entry.count == 1 || marker.area > entry.bestArea) {
        entry.marker = marker;
        entry.bestArea = marker.area;
      }
    }
  }
  std::vector<Entry> entries;
  for (const auto& [id, entry] : byId) entries.push_back(entry);
  std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
    if (a.count != b.count) return a.count > b.count;
    return a.bestArea > b.bestArea;
  });
  std::vector<Marker> markers;
  for (const auto& entry : entries) markers.push_back(entry.marker);
  return markers;
}

ThresholdPass findBestThresholdPass(const cv::Mat& frame, const Options& options) {
  int low = 0;
  int high = 255;
  std::map<int, ThresholdPass> cache;
  auto detectCached = [&](int threshold) -> ThresholdPass {
    auto it = cache.find(threshold);
    if (it != cache.end()) return it->second;
    auto pass = detectThresholdPass(frame, threshold, options);
    cache.emplace(threshold, pass);
    return pass;
  };

  ThresholdPass best = detectCached(low);
  best.path.push_back(low);

  int firstMid = (low + high + 1) / 2;
  auto firstMidPass = detectCached(firstMid);
  best = betterPass(firstMidPass, best) ? firstMidPass : best;
  best.path.push_back(firstMid);

  for (int i = 0; i < kBestThresholdIterations && high - low > 2; ++i) {
    int mid = (low + high + 1) / 2;
    int left = (low + mid + 1) / 2;
    int right = (mid + high + 1) / 2;
    std::vector<ThresholdPass> candidates = {
      detectCached(left),
      detectCached(mid),
      detectCached(right),
    };
    std::sort(candidates.begin(), candidates.end(), betterPass);
    const auto& winner = candidates.front();
    if (betterPass(winner, best)) best = winner;
    best.path.push_back(winner.threshold);

    if (winner.threshold < mid) {
      high = mid;
    } else if (winner.threshold > mid) {
      low = mid;
    } else {
      low = left;
      high = right;
    }
  }
  return best;
}

void drawCross(cv::Mat& frame, cv::Point2f point, cv::Scalar color, int size = 12) {
  cv::line(frame, {static_cast<int>(point.x - size), static_cast<int>(point.y)},
           {static_cast<int>(point.x + size), static_cast<int>(point.y)}, color, 2);
  cv::line(frame, {static_cast<int>(point.x), static_cast<int>(point.y - size)},
           {static_cast<int>(point.x), static_cast<int>(point.y + size)}, color, 2);
}

void drawVector(cv::Mat& frame, cv::Point2f from, cv::Point2f to, cv::Scalar color) {
  cv::arrowedLine(frame, from, to, color, 3, cv::LINE_AA, 0, 0.18);
}

void drawOverlay(cv::Mat& frame, const std::vector<Marker>& markers, const std::vector<Pair>& pairs,
                 std::optional<double> upAngle, int expectedPairs) {
  std::set<int> pairedIds;
  for (const auto& pair : pairs) {
    pairedIds.insert(pair.inner.id);
    pairedIds.insert(pair.outer.id);
  }
  for (const auto& marker : markers) {
    if (!pairedIds.count(marker.id)) drawCross(frame, markerCenter(marker), {80, 255, 80}, 10);
  }
  for (const auto& pair : pairs) {
    auto color = bgrForIndex(pair.index);
    drawVector(frame, pair.innerCenter, pair.outerCenter, color);
    drawCross(frame, pair.innerCenter, color, 12);
    drawCross(frame, pair.outerCenter, color, 12);
    std::ostringstream label;
    label << std::fixed << std::setprecision(1) << pairFixedAngle(pair, expectedPairs);
    cv::Point2f mid = (pair.innerCenter + pair.outerCenter) * 0.5f;
    cv::putText(frame, label.str(), mid, cv::FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv::LINE_AA);
  }
  if (upAngle) {
    cv::Point2f anchor(frame.cols * 0.5f, frame.rows * 0.25f);
    cv::Point2f tip(anchor.x, anchor.y - 80.0f);
    cv::arrowedLine(frame, anchor, tip, {0, 220, 255}, 4, cv::LINE_AA, 0, 0.2);
    std::ostringstream label;
    label << "up: " << std::fixed << std::setprecision(2) << *upAngle;
    cv::putText(frame, label.str(), {static_cast<int>(tip.x - 45), static_cast<int>(tip.y - 12)},
                cv::FONT_HERSHEY_SIMPLEX, 0.55, {0, 220, 255}, 2, cv::LINE_AA);
  }
}

FrameResult processCameraFrame(const cv::Mat& frame, const Options& options) {
  auto start = std::chrono::steady_clock::now();
  double scale = static_cast<double>(options.downscale) / frame.cols;
  cv::Mat preview;
  cv::resize(frame, preview, cv::Size(options.downscale, std::max(1, static_cast<int>(std::round(frame.rows * scale)))));

  FrameResult result;
  result.display = preview.clone();
  if (options.bestThreshold) {
    auto pass = findBestThresholdPass(preview, options);
    result.markers = pass.markers;
    std::ostringstream summary;
    summary << "best t=" << pass.threshold << " " << result.markers.size()
            << " markers/" << pass.score.pairCount << " pairs";
    result.thresholdSummary = summary.str();
    if (options.useThreshold) result.display = applyIntensityThreshold(preview, pass.threshold);
  } else if (options.autoThreshold) {
    std::vector<ThresholdPass> passes = {
      detectThresholdPass(preview, 77, options),
      detectThresholdPass(preview, 128, options),
      detectThresholdPass(preview, 179, options),
    };
    result.markers = compileThresholdMarkers(passes);
    std::ostringstream summary;
    summary << "auto 30/50/70 -> " << result.markers.size() << " markers";
    result.thresholdSummary = summary.str();
    if (options.useThreshold) result.display = applyIntensityThreshold(preview, 128);
  } else {
    cv::Mat detectFrame = preview;
    if (options.useThreshold) {
      result.display = applyIntensityThreshold(preview, options.threshold);
      detectFrame = result.display;
    }
    result.markers = detectMarkers(detectFrame);
  }

  if (options.simpleCross) {
    result.pairs = findMarkerPairs(result.markers);
  } else {
    auto fit = estimateRingPairs(result.markers);
    if (fit) result.pairs = fit->second;
  }
  result.upAngle = computeUpValue(result.pairs, options.expectedPairs);
  result.elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start).count();
  return result;
}

std::vector<int> parseCameraList(const std::string& value) {
  std::vector<int> cameras;
  std::stringstream stream(value);
  std::string item;
  while (std::getline(stream, item, ',')) {
    if (item.empty()) continue;
    cameras.push_back(std::atoi(item.c_str()));
  }
  return cameras;
}

void printUsage(const char* name) {
  std::cerr
      << "Usage: " << name << " [options]\n"
      << "  --camera N            V4L camera index (default 0)\n"
      << "  --cameras A,B,C       open multiple V4L camera indices\n"
      << "  --width N             capture width (default 1280)\n"
      << "  --height N            capture height (default 720)\n"
      << "  --fps N               requested camera capture FPS\n"
      << "  --process-fps N       throttle detector loop FPS; 0 = unlimited\n"
      << "  --downscale N         processing width (default 640)\n"
      << "  --expected-pairs N    expected printed pairs (default 10)\n"
      << "  --threshold N         fixed threshold 0..255\n"
      << "  --exposure N          requested camera exposure value\n"
      << "  --gain N              requested camera gain value\n"
      << "  --brightness N        requested camera brightness value\n"
      << "  --contrast N          requested camera contrast value\n"
      << "  --print-every N       print every N processed frames (default 1)\n"
      << "  --use-threshold       run fixed threshold preview/detection\n"
      << "  --auto-threshold      combine 30/50/70 percent thresholds\n"
      << "  --best-threshold      binary-style per-frame threshold search\n"
      << "  --ring-fit            use ring-fit pair mode instead of simple pair mode\n"
      << "  --no-window           print results without opening an OpenCV window\n"
      << "\n"
      << "Runtime keys in the preview window:\n"
      << "  q/Esc quit, +/- threshold, [/] process FPS, t fixed threshold,\n"
      << "  a auto threshold, b best threshold, r ring/simple mode\n"
      << "Preview trackbars:\n"
      << "  Threshold, Mode 0 raw/1 fixed/2 auto/3 best, Process FPS,\n"
      << "  Capture FPS request, Expected pairs\n";
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
    } else if (arg == "--cameras") {
      if (i + 1 >= argc) return false;
      options.cameras = parseCameraList(argv[++i]);
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
    } else if (arg == "--expected-pairs") {
      if (!readInt(options.expectedPairs)) return false;
    } else if (arg == "--threshold") {
      if (!readInt(options.threshold)) return false;
    } else if (arg == "--exposure") {
      if (!readDouble(options.exposure)) return false;
    } else if (arg == "--gain") {
      if (!readDouble(options.gain)) return false;
    } else if (arg == "--brightness") {
      if (!readDouble(options.brightness)) return false;
    } else if (arg == "--contrast") {
      if (!readDouble(options.contrast)) return false;
    } else if (arg == "--print-every") {
      if (!readInt(options.printEvery)) return false;
    } else if (arg == "--use-threshold") {
      options.useThreshold = true;
    } else if (arg == "--auto-threshold") {
      options.autoThreshold = true;
    } else if (arg == "--best-threshold") {
      options.bestThreshold = true;
    } else if (arg == "--ring-fit") {
      options.simpleCross = false;
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
  options.threshold = std::clamp(options.threshold, 0, 255);
  options.downscale = std::max(1, options.downscale);
  options.expectedPairs = std::max(1, options.expectedPairs);
  options.printEvery = std::max(1, options.printEvery);
  options.processFps = std::max(0.0, options.processFps);
  if (options.cameras.empty()) options.cameras.push_back(options.camera);
  return true;
}

void setIfRequested(cv::VideoCapture& cap, int prop, double value, const char* name) {
  if (std::isnan(value)) return;
  bool ok = cap.set(prop, value);
  double actual = cap.get(prop);
  std::cerr << name << " requested=" << value << " actual=" << actual
            << (ok ? "" : " (driver did not confirm)") << "\n";
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  if (!parseArgs(argc, argv, options)) {
    printUsage(argv[0]);
    return 2;
  }

  std::vector<CameraState> cameras;
  for (int cameraIndex : options.cameras) {
    CameraState state;
    state.index = cameraIndex;
    state.windowName = "basic fiducial native reader cam " + std::to_string(cameraIndex);
    state.cap.open(cameraIndex, cv::CAP_V4L2);
    if (!state.cap.isOpened()) {
      std::cerr << "Failed to open camera index " << cameraIndex << "\n";
      continue;
    }
    state.cap.set(cv::CAP_PROP_FRAME_WIDTH, options.width);
    state.cap.set(cv::CAP_PROP_FRAME_HEIGHT, options.height);
    state.cap.set(cv::CAP_PROP_FOURCC, cv::VideoWriter::fourcc('M', 'J', 'P', 'G'));
    if (options.fps > 0.0) state.cap.set(cv::CAP_PROP_FPS, options.fps);
    setIfRequested(state.cap, cv::CAP_PROP_EXPOSURE, options.exposure, "exposure");
    setIfRequested(state.cap, cv::CAP_PROP_GAIN, options.gain, "gain");
    setIfRequested(state.cap, cv::CAP_PROP_BRIGHTNESS, options.brightness, "brightness");
    setIfRequested(state.cap, cv::CAP_PROP_CONTRAST, options.contrast, "contrast");

    std::cerr << "camera=" << state.index
              << " capture=" << state.cap.get(cv::CAP_PROP_FRAME_WIDTH) << "x" << state.cap.get(cv::CAP_PROP_FRAME_HEIGHT)
              << " fps=" << state.cap.get(cv::CAP_PROP_FPS)
              << " processing_width=" << options.downscale
              << " process_fps=" << (options.processFps > 0.0 ? std::to_string(options.processFps) : "unlimited")
              << "\n";
    cameras.push_back(std::move(state));
  }
  if (cameras.empty()) {
    std::cerr << "No cameras opened\n";
    return 1;
  }

  const std::string controlsWindowName = cameras.front().windowName;
  int thresholdTrack = options.threshold;
  int modeTrack = options.bestThreshold ? 3 : (options.autoThreshold ? 2 : (options.useThreshold ? 1 : 0));
  int processFpsTrack = static_cast<int>(std::round(options.processFps));
  int captureFpsTrack = options.fps > 0.0
      ? static_cast<int>(std::round(options.fps))
      : static_cast<int>(std::round(cameras.front().cap.get(cv::CAP_PROP_FPS)));
  int expectedPairsTrack = options.expectedPairs;
  for (auto& camera : cameras) camera.lastCaptureFpsTrack = captureFpsTrack;
  if (!options.noWindow) {
    for (const auto& camera : cameras) cv::namedWindow(camera.windowName, cv::WINDOW_NORMAL);
    cv::createTrackbar("Threshold", controlsWindowName, &thresholdTrack, 255);
    cv::createTrackbar("Mode 0raw 1fix 2auto 3best", controlsWindowName, &modeTrack, 3);
    cv::createTrackbar("Process FPS 0=max", controlsWindowName, &processFpsTrack, 60);
    cv::createTrackbar("Capture FPS request", controlsWindowName, &captureFpsTrack, 60);
    cv::createTrackbar("Expected pairs", controlsWindowName, &expectedPairsTrack, 20);
  }

  auto nextFrameAt = std::chrono::steady_clock::now();
  while (true) {
    auto loopStart = std::chrono::steady_clock::now();
    if (!options.noWindow) {
      options.threshold = std::clamp(thresholdTrack, 0, 255);
      options.processFps = std::max(0, processFpsTrack);
      options.expectedPairs = std::max(1, expectedPairsTrack);
      modeTrack = std::clamp(modeTrack, 0, 3);
      options.useThreshold = modeTrack == 1;
      options.autoThreshold = modeTrack == 2;
      options.bestThreshold = modeTrack == 3;
      for (auto& camera : cameras) {
        if (captureFpsTrack != camera.lastCaptureFpsTrack) {
          camera.lastCaptureFpsTrack = captureFpsTrack;
          if (captureFpsTrack > 0) {
            camera.cap.set(cv::CAP_PROP_FPS, captureFpsTrack);
            std::cerr << "camera=" << camera.index
                      << " capture FPS requested=" << captureFpsTrack
                      << " actual=" << camera.cap.get(cv::CAP_PROP_FPS) << "\n";
          }
        }
      }
    }

    for (auto& camera : cameras) {
      cv::Mat frame;
      if (!camera.cap.read(frame) || frame.empty()) {
        std::cerr << "camera=" << camera.index << " failed to read frame\n";
        continue;
      }

      auto result = processCameraFrame(frame, options);
      std::ostringstream ids;
      for (size_t i = 0; i < result.markers.size(); ++i) {
        if (i) ids << ",";
        ids << "#" << result.markers[i].id;
      }
      if (camera.frameNo % options.printEvery == 0) {
        std::cout << "cam=" << camera.index
                  << " frame=" << camera.frameNo
                  << " ms=" << result.elapsedMs
                  << " markers=" << result.markers.size()
                  << " pairs=" << result.pairs.size() << "/" << options.expectedPairs
                  << " angle=" << (result.upAngle ? std::to_string(*result.upAngle) : "n/a")
                  << " ids=" << ids.str();
        if (!result.thresholdSummary.empty()) std::cout << " " << result.thresholdSummary;
        std::cout << std::endl;
      }
      camera.frameNo++;

      if (!options.noWindow) {
        drawOverlay(result.display, result.markers, result.pairs, result.upAngle, options.expectedPairs);
        std::ostringstream hud;
        hud << "cam " << camera.index
            << " | cap " << camera.cap.get(cv::CAP_PROP_FPS)
            << " fps | proc " << (options.processFps > 0.0 ? std::to_string(options.processFps) : "max")
            << " | t=" << options.threshold
            << " | mode=" << (options.bestThreshold ? "best" : (options.autoThreshold ? "auto" : (options.useThreshold ? "fixed" : "raw")));
        cv::putText(result.display, hud.str(), {12, 24}, cv::FONT_HERSHEY_SIMPLEX, 0.55, {255, 255, 255}, 2, cv::LINE_AA);
        cv::imshow(camera.windowName, result.display);
      }
    }

    if (!options.noWindow) {
      int key = cv::waitKey(1);
      if (key == 27 || key == 'q' || key == 'Q') break;
      if (key == '+' || key == '=') thresholdTrack = std::min(255, thresholdTrack + 4);
      if (key == '-' || key == '_') thresholdTrack = std::max(0, thresholdTrack - 4);
      if (key == '[') processFpsTrack = std::max(0, processFpsTrack - 1);
      if (key == ']') processFpsTrack = std::min(60, processFpsTrack + 1);
      if (key == 't' || key == 'T') {
        modeTrack = modeTrack == 1 ? 0 : 1;
      }
      if (key == 'a' || key == 'A') {
        modeTrack = modeTrack == 2 ? 0 : 2;
      }
      if (key == 'b' || key == 'B') {
        modeTrack = modeTrack == 3 ? 0 : 3;
      }
      if (key == 'r' || key == 'R') options.simpleCross = !options.simpleCross;
      cv::setTrackbarPos("Threshold", controlsWindowName, thresholdTrack);
      cv::setTrackbarPos("Mode 0raw 1fix 2auto 3best", controlsWindowName, modeTrack);
      cv::setTrackbarPos("Process FPS 0=max", controlsWindowName, processFpsTrack);
      cv::setTrackbarPos("Capture FPS request", controlsWindowName, captureFpsTrack);
      cv::setTrackbarPos("Expected pairs", controlsWindowName, expectedPairsTrack);
    }

    if (options.processFps > 0.0) {
      const auto framePeriod = std::chrono::duration<double>(1.0 / options.processFps);
      nextFrameAt = std::max(nextFrameAt + std::chrono::duration_cast<std::chrono::steady_clock::duration>(framePeriod), loopStart);
      std::this_thread::sleep_until(nextFrameAt);
    }
  }

  return 0;
}
