#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cerrno>
#include <cstring>
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

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

namespace {

constexpr int kAngleSlotCount = 20;
constexpr int kBestThresholdIterations = 6;

enum class ReaderMode {
  FIDUCIAL,
  COLOR_LINE,
};

struct Options {
  int camera = 0;
  std::vector<int> cameras;
  int maxCameraIndex = 16;
  ReaderMode readerMode = ReaderMode::FIDUCIAL;
  int width = 1280;
  int height = 720;
  int downscale = 640;
  int colorLineCropPercent = 34;
  bool colorLineRadialScans = false;
  int expectedPairs = 10;
  int threshold = 128;
  int tileWidth = 0;
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
  bool robustColor = false;
  bool noWindow = false;
  bool separateWindows = false;
  bool angleLine = false;
  bool angleCsv = false;
  int tcpPort = 0;
  int udpPort = 0;
  std::string udpTargetHost;
  int udpTargetPort = 0;
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
  std::optional<double> stripeAngle;
  std::optional<double> imageNormalAngle;
  cv::Rect analysisRect;
  std::string thresholdSummary;
  long elapsedMs = 0;
};

enum class ColorClass {
  NONE,
  RED,
  YELLOW,
  BLUE,
};

struct ColorSample {
  int pos = 0;
  ColorClass color = ColorClass::NONE;
};

struct ColorRun {
  ColorClass color = ColorClass::NONE;
  int start = 0;
  int end = 0;
  int count = 0;
  double center = 0.0;
};

struct ColorScan {
  std::string axis;
  std::string label;
  double angleDeg = 0.0;
  cv::Point2d vector;
  std::vector<ColorRun> runs;
  int direction = 0;
  int votes = 0;
  int score = 0;
  double medianLength = 0.0;
  bool hasGap = false;
  bool isSolid = false;
  int maxGap = 0;
  double gapThreshold = 0.0;
  double solidCoverage = 0.0;
};

struct ColorLineFit {
  double imageNormalAngle = 0.0;
  double rawAngle = 0.0;
  double angle = 0.0;
  double stripeAngle = 0.0;
  double maxCoverageGap = 0.0;
  double coverageCondition = 0.0;
  std::vector<ColorScan> allScans;
  std::vector<ColorScan> fittedScans;
  std::vector<ColorScan> excludedScans;
};

struct CameraFrame {
  int cameraIndex = 0;
  int frameNo = 0;
  double captureFps = 0.0;
  FrameResult result;
};

double normalizeDeg(double value) {
  double result = std::fmod(value, 360.0);
  if (result < 0.0) result += 360.0;
  return result;
}

double detectedColorLineAngleFromRaw(double rawAngle) {
  return normalizeDeg(rawAngle + 90.0);
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

ColorClass classifyColorLinePixel(const cv::Vec3b& bgr, bool robustColor) {
  const double b = bgr[0];
  const double g = bgr[1];
  const double r = bgr[2];
  const double maxValue = std::max({r, g, b});
  const double minValue = std::min({r, g, b});
  const double minBrightness = robustColor ? 18.0 : 24.0;
  const double minScore = robustColor ? 1.10 : 1.25;
  const double minMargin = robustColor ? 1.04 : 1.10;
  if (maxValue < minBrightness || maxValue - minValue < 6.0) return ColorClass::NONE;

  const double redScore = r / (g + b + 1.0);
  const double blueScore = b / (r + g + 1.0);
  const double yellowScore = std::min(r, g) / (b + std::abs(r - g) + 1.0);

  ColorClass bestColor = ColorClass::RED;
  double bestScore = redScore;
  double secondScore = std::max(yellowScore, blueScore);
  if (yellowScore > bestScore) {
    bestColor = ColorClass::YELLOW;
    bestScore = yellowScore;
    secondScore = std::max(redScore, blueScore);
  }
  if (blueScore > bestScore) {
    bestColor = ColorClass::BLUE;
    bestScore = blueScore;
    secondScore = std::max(redScore, yellowScore);
  }

  if (bestScore < minScore || bestScore < secondScore * minMargin) return ColorClass::NONE;
  return bestColor;
}

const char* colorClassName(ColorClass color) {
  switch (color) {
    case ColorClass::RED: return "red";
    case ColorClass::YELLOW: return "yellow";
    case ColorClass::BLUE: return "blue";
    default: return "none";
  }
}

int borderDirection(ColorClass left, ColorClass right) {
  if ((left == ColorClass::RED && right == ColorClass::YELLOW) ||
      (left == ColorClass::YELLOW && right == ColorClass::BLUE) ||
      (left == ColorClass::BLUE && right == ColorClass::RED)) {
    return 1;
  }
  if ((left == ColorClass::YELLOW && right == ColorClass::RED) ||
      (left == ColorClass::BLUE && right == ColorClass::YELLOW) ||
      (left == ColorClass::RED && right == ColorClass::BLUE)) {
    return -1;
  }
  return 0;
}

double medianRunLength(const std::vector<ColorRun>& runs) {
  if (runs.empty()) return 0.0;
  std::vector<int> lengths;
  const int begin = runs.size() >= 3 ? 1 : 0;
  const int end = runs.size() >= 3 ? static_cast<int>(runs.size()) - 1 : static_cast<int>(runs.size());
  for (int i = begin; i < end; ++i) {
    if (runs[i].count >= 3) lengths.push_back(runs[i].count);
  }
  if (lengths.empty()) return 0.0;
  std::sort(lengths.begin(), lengths.end());
  return static_cast<double>(lengths[lengths.size() / 2]);
}

std::vector<ColorRun> compressColorRuns(const std::vector<ColorSample>& samples) {
  std::vector<ColorRun> runs;
  for (const auto& sample : samples) {
    if (sample.color == ColorClass::NONE) continue;
    if (!runs.empty() && runs.back().color == sample.color && sample.pos <= runs.back().end + 1) {
      runs.back().end = sample.pos;
      runs.back().count++;
    } else {
      runs.push_back({sample.color, sample.pos, sample.pos, 1, static_cast<double>(sample.pos)});
    }
  }

  std::vector<ColorRun> filtered;
  for (auto run : runs) {
    if (run.count < 3) continue;
    run.center = (run.start + run.end) / 2.0;
    filtered.push_back(run);
  }
  return filtered;
}

void populateColorScanStats(ColorScan& scan, const std::vector<ColorSample>& samples) {
  scan.runs = compressColorRuns(samples);
  for (size_t i = 1; i < scan.runs.size(); ++i) {
    const int direction = borderDirection(scan.runs[i - 1].color, scan.runs[i].color);
    if (direction == 0) continue;
    scan.score += direction;
    scan.votes++;
  }
  scan.direction = scan.score > 0 ? 1 : scan.score < 0 ? -1 : 0;
  scan.medianLength = medianRunLength(scan.runs);
  if (!samples.empty() && scan.runs.size() == 1) {
    scan.solidCoverage = static_cast<double>(scan.runs.front().count) / samples.size();
    scan.isSolid = scan.solidCoverage >= 0.7;
  }

  if (scan.runs.size() < 2) return;
  scan.gapThreshold = std::max(6.0, scan.medianLength * 0.45);
  int currentGap = 0;
  const int first = scan.runs.front().start;
  const int last = scan.runs.back().end;
  for (const auto& sample : samples) {
    if (sample.pos < first || sample.pos > last) continue;
    if (sample.color != ColorClass::NONE) {
      scan.maxGap = std::max(scan.maxGap, currentGap);
      currentGap = 0;
    } else {
      currentGap++;
    }
  }
  scan.maxGap = std::max(scan.maxGap, currentGap);
  scan.hasGap = scan.maxGap >= scan.gapThreshold;
}

ColorScan scanColorLineRadial(const cv::Mat& image, double angleDeg, const Options& options) {
  const double radians = angleDeg * CV_PI / 180.0;
  const double ux = std::cos(radians);
  const double uy = std::sin(radians);
  const double cx = (image.cols - 1) / 2.0;
  const double cy = (image.rows - 1) / 2.0;
  const double halfWidth = (image.cols - 1) / 2.0;
  const double halfHeight = (image.rows - 1) / 2.0;
  const double xLimit = std::abs(ux) < 1e-9 ? std::numeric_limits<double>::infinity() : halfWidth / std::abs(ux);
  const double yLimit = std::abs(uy) < 1e-9 ? std::numeric_limits<double>::infinity() : halfHeight / std::abs(uy);
  const double maxT = std::min(xLimit, yLimit);

  std::vector<ColorSample> samples;
  int lastX = -1;
  int lastY = -1;
  int pos = 0;
  for (double t = -maxT; t <= maxT; t += 1.0) {
    const int x = std::clamp(static_cast<int>(std::round(cx + ux * t)), 0, image.cols - 1);
    const int y = std::clamp(static_cast<int>(std::round(cy + uy * t)), 0, image.rows - 1);
    if (x == lastX && y == lastY) continue;
    lastX = x;
    lastY = y;
    samples.push_back({pos++, classifyColorLinePixel(image.at<cv::Vec3b>(y, x), options.robustColor)});
  }

  ColorScan scan;
  scan.angleDeg = angleDeg;
  std::ostringstream axis;
  axis << "radial" << std::fixed << std::setprecision(angleDeg == std::round(angleDeg) ? 0 : 1) << angleDeg;
  scan.axis = axis.str();
  std::ostringstream label;
  label << std::fixed << std::setprecision(angleDeg == std::round(angleDeg) ? 0 : 1) << angleDeg << "deg";
  scan.label = label.str();
  scan.vector = {ux, uy};
  populateColorScanStats(scan, samples);
  return scan;
}

bool colorScanIsUsable(const ColorScan& scan) {
  return scan.medianLength > 0.0 && scan.direction != 0 && !scan.hasGap;
}

bool colorScanIsConstraint(const ColorScan& scan) {
  return colorScanIsUsable(scan) || (scan.isSolid && !scan.hasGap);
}

std::optional<std::pair<double, double>> colorScanCoverage(const std::vector<ColorScan>& constraints) {
  if (constraints.size() < 2) return std::nullopt;
  std::vector<double> angles;
  for (const auto& scan : constraints) angles.push_back(std::fmod(normalizeDeg(scan.angleDeg), 180.0));
  std::sort(angles.begin(), angles.end());

  double maxGap = 0.0;
  for (size_t i = 0; i < angles.size(); ++i) {
    const double next = i + 1 == angles.size() ? angles.front() + 180.0 : angles[i + 1];
    maxGap = std::max(maxGap, next - angles[i]);
  }

  double aa = 0.0;
  double ab = 0.0;
  double bb = 0.0;
  for (const auto& scan : constraints) {
    aa += scan.vector.x * scan.vector.x;
    ab += scan.vector.x * scan.vector.y;
    bb += scan.vector.y * scan.vector.y;
  }
  const double trace = aa + bb;
  const double det = aa * bb - ab * ab;
  if (det <= 1e-9) return std::nullopt;
  const double root = std::sqrt(std::max(0.0, trace * trace - 4.0 * det));
  const double lambdaMax = (trace + root) / 2.0;
  const double lambdaMin = (trace - root) / 2.0;
  const double condition = lambdaMin > 1e-9 ? lambdaMax / lambdaMin : std::numeric_limits<double>::infinity();
  if (condition > 8.0) return std::nullopt;
  return std::make_pair(maxGap, condition);
}

std::optional<ColorLineFit> fitColorLineFromScans(const std::vector<ColorScan>& scans) {
  std::vector<ColorScan> usable;
  std::vector<ColorScan> constraints;
  std::vector<ColorScan> excluded;
  for (const auto& scan : scans) {
    if (colorScanIsUsable(scan)) usable.push_back(scan);
    if (colorScanIsConstraint(scan)) {
      constraints.push_back(scan);
    } else {
      excluded.push_back(scan);
    }
  }
  if (usable.empty() || constraints.size() < 2) return std::nullopt;
  auto coverage = colorScanCoverage(constraints);
  if (!coverage) return std::nullopt;

  double aa = 0.0;
  double ab = 0.0;
  double bb = 0.0;
  double ac = 0.0;
  double bc = 0.0;
  for (const auto& scan : constraints) {
    const double projection = scan.isSolid ? 0.0 : scan.direction / scan.medianLength;
    aa += scan.vector.x * scan.vector.x;
    ab += scan.vector.x * scan.vector.y;
    bb += scan.vector.y * scan.vector.y;
    ac += scan.vector.x * projection;
    bc += scan.vector.y * projection;
  }

  const double det = aa * bb - ab * ab;
  if (std::abs(det) < 1e-9) return std::nullopt;
  const double nx = (ac * bb - bc * ab) / det;
  const double ny = (aa * bc - ab * ac) / det;
  if (!std::isfinite(nx) || !std::isfinite(ny) || (nx == 0.0 && ny == 0.0)) return std::nullopt;

  ColorLineFit fit;
  fit.allScans = scans;
  fit.fittedScans = constraints;
  fit.excludedScans = excluded;
  fit.maxCoverageGap = coverage->first;
  fit.coverageCondition = coverage->second;
  fit.imageNormalAngle = normalizeDeg(std::atan2(ny, nx) * 180.0 / CV_PI);
  fit.rawAngle = normalizeDeg(360.0 - fit.imageNormalAngle);
  fit.angle = detectedColorLineAngleFromRaw(fit.rawAngle);
  fit.stripeAngle = normalizeDeg(fit.rawAngle + 90.0);
  return fit;
}

std::string colorLineScanSummary(const std::vector<ColorScan>& scans) {
  std::ostringstream out;
  for (size_t i = 0; i < scans.size(); ++i) {
    if (i) out << "; ";
    out << scans[i].label << "=";
    if (scans[i].hasGap) {
      out << "gap " << scans[i].maxGap << "px";
    } else if (!colorScanIsUsable(scans[i])) {
      out << "unusable";
    } else {
      for (const auto& run : scans[i].runs) out << colorClassName(run.color)[0];
    }
  }
  return out.str();
}

FrameResult processColorLineFrame(const cv::Mat& frame, const Options& options) {
  auto start = std::chrono::steady_clock::now();
  double scale = static_cast<double>(options.downscale) / frame.cols;
  cv::Mat preview;
  cv::resize(frame, preview, cv::Size(options.downscale, std::max(1, static_cast<int>(std::round(frame.rows * scale)))));

  FrameResult result;
  result.display = preview.clone();
  const int cropPercent = std::clamp(options.colorLineCropPercent, 5, 100);
  const int squareSize = std::max(2, static_cast<int>(std::round((cropPercent / 100.0) * std::min(preview.cols, preview.rows))));
  const int left = std::max(0, (preview.cols - squareSize) / 2);
  const int top = std::max(0, (preview.rows - squareSize) / 2);
  result.analysisRect = cv::Rect(left, top, std::min(squareSize, preview.cols - left), std::min(squareSize, preview.rows - top));

  static const std::vector<double> twoLineScanAngles = {0.0, 90.0};
  static const std::vector<double> radialScanAngles = {0.0, 22.5, 45.0, 67.5, 90.0, 112.5, 135.0, 157.5};
  const auto& scanAngles = options.colorLineRadialScans ? radialScanAngles : twoLineScanAngles;
  cv::Mat crop = preview(result.analysisRect).clone();
  std::vector<ColorScan> scans;
  for (double angle : scanAngles) scans.push_back(scanColorLineRadial(crop, angle, options));

  auto fit = fitColorLineFromScans(scans);
  if (fit) {
    result.upAngle = fit->angle;
    result.stripeAngle = fit->stripeAngle;
    result.imageNormalAngle = fit->imageNormalAngle;
    std::ostringstream summary;
    summary << (options.colorLineRadialScans ? "color-line radial used " : "color-line two-line used ")
            << fit->fittedScans.size() << "/" << fit->allScans.size()
            << " maxGap=" << std::fixed << std::setprecision(1) << fit->maxCoverageGap
            << " cond=" << fit->coverageCondition
            << " stripe=" << fit->stripeAngle;
    result.thresholdSummary = summary.str();
  } else {
    result.thresholdSummary = "color-line no fit: " + colorLineScanSummary(scans);
  }

  result.elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - start).count();
  return result;
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

void drawColorLineOverlay(cv::Mat& frame, const FrameResult& result) {
  if (result.analysisRect.empty()) return;
  cv::rectangle(frame, result.analysisRect, {0, 255, 255}, 2, cv::LINE_AA);
  const cv::Point2f center(result.analysisRect.x + result.analysisRect.width * 0.5f,
                           result.analysisRect.y + result.analysisRect.height * 0.5f);
  const double len = std::max(result.analysisRect.width, result.analysisRect.height) * 0.65;

  if (result.imageNormalAngle) {
    const double normalRadians = *result.imageNormalAngle * CV_PI / 180.0;
    const double stripeRadians = normalRadians + CV_PI / 2.0;
    cv::Point2f stripeDelta(static_cast<float>(std::cos(stripeRadians) * len),
                            static_cast<float>(std::sin(stripeRadians) * len));
    cv::line(frame, center - stripeDelta, center + stripeDelta, {255, 255, 0}, 3, cv::LINE_AA);

    cv::Point2f normalDelta(static_cast<float>(std::cos(normalRadians) * len * 0.55),
                            static_cast<float>(std::sin(normalRadians) * len * 0.55));
    cv::arrowedLine(frame, center, center + normalDelta, {255, 0, 255}, 3, cv::LINE_AA, 0, 0.18);
  }

  std::ostringstream label;
  label << "color-line: ";
  if (result.upAngle) {
    label << std::fixed << std::setprecision(2) << *result.upAngle << " deg";
  } else {
    label << "no angle";
  }
  const int baselineY = std::max(18, result.analysisRect.y - 8);
  cv::putText(frame, label.str(), {result.analysisRect.x + 6, baselineY},
              cv::FONT_HERSHEY_SIMPLEX, 0.55, {0, 255, 255}, 2, cv::LINE_AA);
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

cv::Mat composeMosaic(const std::vector<CameraFrame>& frames, int requestedTileWidth) {
  if (frames.empty()) return {};
  const int count = static_cast<int>(frames.size());
  const int cols = static_cast<int>(std::ceil(std::sqrt(count)));
  const int rows = static_cast<int>(std::ceil(static_cast<double>(count) / cols));
  const int tileWidth = requestedTileWidth > 0 ? requestedTileWidth : std::min(420, frames.front().result.display.cols);
  const double aspect = static_cast<double>(frames.front().result.display.rows) / frames.front().result.display.cols;
  const int tileHeight = std::max(1, static_cast<int>(std::round(tileWidth * aspect)));

  cv::Mat mosaic(rows * tileHeight, cols * tileWidth, CV_8UC3, cv::Scalar(18, 18, 18));
  for (int i = 0; i < count; ++i) {
    cv::Mat tile;
    cv::resize(frames[i].result.display, tile, cv::Size(tileWidth, tileHeight));
    const int row = i / cols;
    const int col = i % cols;
    cv::Rect roi(col * tileWidth, row * tileHeight, tileWidth, tileHeight);
    tile.copyTo(mosaic(roi));

    std::ostringstream label;
    label << "cam " << frames[i].cameraIndex
          << " | cap " << frames[i].captureFps
          << " | ms " << frames[i].result.elapsedMs
          << " | pairs " << frames[i].result.pairs.size()
          << " | angle "
          << (frames[i].result.upAngle ? std::to_string(*frames[i].result.upAngle).substr(0, 6) : "n/a");
    cv::rectangle(mosaic, {roi.x, roi.y}, {roi.x + tileWidth, roi.y + 28}, {0, 0, 0}, cv::FILLED);
    cv::putText(mosaic, label.str(), {roi.x + 8, roi.y + 20},
                cv::FONT_HERSHEY_SIMPLEX, 0.52, {255, 255, 255}, 1, cv::LINE_AA);
    cv::rectangle(mosaic, roi, {70, 70, 70}, 1);
  }
  return mosaic;
}

FrameResult processCameraFrame(const cv::Mat& frame, const Options& options) {
  if (options.readerMode == ReaderMode::COLOR_LINE) return processColorLineFrame(frame, options);

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

std::vector<int> detectConnectedCameras(int maxCameraIndex) {
  std::vector<int> cameras;
  for (int cameraIndex = 0; cameraIndex <= maxCameraIndex; ++cameraIndex) {
    cv::VideoCapture cap(cameraIndex, cv::CAP_V4L2);
    if (!cap.isOpened()) continue;

    cv::Mat frame;
    if (cap.read(frame) && !frame.empty()) {
      cameras.push_back(cameraIndex);
      std::cerr << "Detected camera index " << cameraIndex << "\n";
    }
  }
  return cameras;
}

std::string formatAngle(std::optional<double> angle, int precision = 2) {
  if (!angle) return "n/a";
  std::ostringstream out;
  out << std::fixed << std::setprecision(precision) << *angle;
  return out.str();
}

// ---------------------------------------------------------------------------
// Telemetry networking: one shared TCP port and one shared UDP port. Every
// camera's per-frame result (angle/pairs/markers) is broadcast to whoever is
// listening. A "camera" field in each JSON line tells clients which camera a
// message came from, so multiple cameras can share a single port pair.
//
// TCP: standard listening socket. Any client that connects receives a stream
// of newline-delimited JSON objects, one per processed frame per camera,
// until it disconnects.
//
// UDP: since UDP has no concept of a "connection", a client subscribes by
// sending any datagram (even an empty one) to the UDP port. That sender's
// address is remembered and future telemetry is sent to it. There is no
// automatic expiry of subscribers; a client that goes away just silently
// stops receiving useful traffic (sends to a dead address are cheap no-ops
// on Linux).
// ---------------------------------------------------------------------------

std::string jsonAngleField(std::optional<double> angle) {
  if (!angle) return "null";
  return formatAngle(angle, 6);
}

std::string buildTelemetryJson(int64_t tsMs, int cameraIndex, int frameNo,
                               const FrameResult& result, int expectedPairs) {
  std::ostringstream out;
  out << "{\"ts_ms\":" << tsMs
      << ",\"camera\":" << cameraIndex
      << ",\"frame\":" << frameNo
      << ",\"angle\":" << jsonAngleField(result.upAngle)
      << ",\"pairs\":" << result.pairs.size()
      << ",\"expected_pairs\":" << expectedPairs
      << ",\"markers\":" << result.markers.size()
      << ",\"elapsed_ms\":" << result.elapsedMs
      << "}";
  return out.str();
}

class TelemetryServer {
 public:
  ~TelemetryServer() { stop(); }

  bool startTcp(int port) {
    tcpFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (tcpFd_ < 0) return false;
    int opt = 1;
    ::setsockopt(tcpFd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    if (::bind(tcpFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
      ::close(tcpFd_);
      tcpFd_ = -1;
      return false;
    }
    if (::listen(tcpFd_, 16) < 0) {
      ::close(tcpFd_);
      tcpFd_ = -1;
      return false;
    }
    setNonBlocking(tcpFd_);
    return true;
  }

  bool startUdp(int port) {
    udpFd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (udpFd_ < 0) return false;
    if (port > 0) {
      int opt = 1;
      ::setsockopt(udpFd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
      sockaddr_in addr{};
      addr.sin_family = AF_INET;
      addr.sin_addr.s_addr = INADDR_ANY;
      addr.sin_port = htons(static_cast<uint16_t>(port));
      if (::bind(udpFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(udpFd_);
        udpFd_ = -1;
        return false;
      }
    }
    setNonBlocking(udpFd_);
    return true;
  }

  bool addUdpTarget(const std::string& host, int port) {
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    if (::inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) return false;
    addUdpSubscriber(addr, "udp target added ");
    return true;
  }

  // Call once per loop iteration: accepts new TCP clients and registers any
  // new UDP subscribers without blocking.
  void poll() {
    acceptTcpClients();
    pollUdpSubscribers();
  }

  void broadcast(const std::string& line) {
    const std::string payload = line + "\n";
    broadcastTcp(payload);
    broadcastUdp(payload);
  }

  void stop() {
    for (int fd : tcpClients_) ::close(fd);
    tcpClients_.clear();
    if (tcpFd_ >= 0) { ::close(tcpFd_); tcpFd_ = -1; }
    if (udpFd_ >= 0) { ::close(udpFd_); udpFd_ = -1; }
  }

  int tcpClientCount() const { return static_cast<int>(tcpClients_.size()); }
  int udpSubscriberCount() const { return static_cast<int>(udpSubscribers_.size()); }

 private:
  static void setNonBlocking(int fd) {
    int flags = ::fcntl(fd, F_GETFL, 0);
    ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  }

  void acceptTcpClients() {
    if (tcpFd_ < 0) return;
    while (true) {
      sockaddr_in clientAddr{};
      socklen_t len = sizeof(clientAddr);
      int clientFd = ::accept(tcpFd_, reinterpret_cast<sockaddr*>(&clientAddr), &len);
      if (clientFd < 0) break;
      setNonBlocking(clientFd);
      int opt = 1;
      ::setsockopt(clientFd, IPPROTO_TCP, TCP_NODELAY, &opt, sizeof(opt));
      tcpClients_.push_back(clientFd);
      std::cerr << "telemetry: tcp client connected " << inet_ntoa(clientAddr.sin_addr)
                << ":" << ntohs(clientAddr.sin_port)
                << " (total " << tcpClients_.size() << ")\n";
    }
  }

  void pollUdpSubscribers() {
    if (udpFd_ < 0) return;
    char buf[512];
    while (true) {
      sockaddr_in srcAddr{};
      socklen_t len = sizeof(srcAddr);
      ssize_t n = ::recvfrom(udpFd_, buf, sizeof(buf), 0, reinterpret_cast<sockaddr*>(&srcAddr), &len);
      if (n < 0) break;
      addUdpSubscriber(srcAddr, "udp subscriber added ");
    }
  }

  void addUdpSubscriber(const sockaddr_in& addr, const char* label) {
    const uint64_t key = (static_cast<uint64_t>(addr.sin_addr.s_addr) << 16) | ntohs(addr.sin_port);
    if (udpSubscriberKeys_.insert(key).second) {
      udpSubscribers_.push_back(addr);
      std::cerr << "telemetry: " << label << inet_ntoa(addr.sin_addr)
                << ":" << ntohs(addr.sin_port)
                << " (total " << udpSubscribers_.size() << ")\n";
    }
  }

  void broadcastTcp(const std::string& payload) {
    if (tcpClients_.empty()) return;
    std::vector<int> dead;
    for (int fd : tcpClients_) {
      ssize_t sent = ::send(fd, payload.data(), payload.size(), MSG_NOSIGNAL);
      if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK) dead.push_back(fd);
    }
    if (!dead.empty()) {
      for (int fd : dead) {
        ::close(fd);
        tcpClients_.erase(std::remove(tcpClients_.begin(), tcpClients_.end(), fd), tcpClients_.end());
      }
      std::cerr << "telemetry: tcp client(s) dropped, remaining " << tcpClients_.size() << "\n";
    }
  }

  void broadcastUdp(const std::string& payload) {
    if (udpFd_ < 0 || udpSubscribers_.empty()) return;
    for (const auto& addr : udpSubscribers_) {
      ssize_t sent = ::sendto(udpFd_, payload.data(), payload.size(), 0,
                              reinterpret_cast<const sockaddr*>(&addr), sizeof(addr));
      if (sent < 0 && !udpSendErrorLogged_) {
        udpSendErrorLogged_ = true;
        std::cerr << "telemetry: udp send failed: " << std::strerror(errno) << "\n";
      }
    }
  }

  int tcpFd_ = -1;
  int udpFd_ = -1;
  std::vector<int> tcpClients_;
  std::vector<sockaddr_in> udpSubscribers_;
  std::set<uint64_t> udpSubscriberKeys_;
  bool udpSendErrorLogged_ = false;
};

bool parseHostPort(const std::string& value, std::string& host, int& port) {
  size_t sep = value.rfind(':');
  if (sep == std::string::npos || sep == 0 || sep + 1 >= value.size()) return false;
  host = value.substr(0, sep);
  port = std::atoi(value.substr(sep + 1).c_str());
  return port > 0 && port <= 65535;
}

void printUsage(const char* name) {
  std::cerr
      << "Usage: " << name << " [options]\n"
      << "  --camera N            V4L camera index; overrides auto detection\n"
      << "  --cameras A,B,C       open multiple V4L camera indices\n"
      << "  --max-camera-index N  highest V4L index to probe for auto detection (default 16)\n"
      << "  --width N             capture width (default 1280)\n"
      << "  --height N            capture height (default 720)\n"
      << "  --fps N               requested camera capture FPS\n"
      << "  --process-fps N       throttle detector loop FPS; 0 = unlimited\n"
      << "  --downscale N         processing width (default 640)\n"
      << "  --color-line-reader   use color_line_reader two-line scan algorithm\n"
      << "  --color-line-crop N   centered square crop percent for color-line mode (default 34)\n"
      << "  --color-line-radial   use 8 radial scanlines instead of stable 2-line mode\n"
      << "  --robust-color        use color_line_reader robust color thresholds\n"
      << "  --tile-width N        grid display tile width; 0 = auto\n"
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
      << "  --separate-windows    show one OpenCV window per camera instead of a grid\n"
      << "  --angle-line          print one updating line with all camera angles\n"
      << "  --angle-csv           print timestamp,camera,angle,pairs,markers rows\n"
      << "  --tcp-port N          serve telemetry JSON to any TCP client on port N\n"
      << "  --udp-port N          serve telemetry JSON to UDP clients that send a\n"
      << "                        subscribe datagram (any bytes) to port N\n"
      << "  --udp-target H:P      send telemetry JSON over UDP to IPv4 host H, port P\n"
      << "\n"
      << "Telemetry (--tcp-port / --udp-port), one shared port for all cameras:\n"
      << "  Each processed frame emits one JSON line, e.g.:\n"
      << "    {\"ts_ms\":1731093012345,\"camera\":0,\"frame\":42,\"angle\":187.512400,\n"
      << "     \"pairs\":9,\"expected_pairs\":10,\"markers\":18,\"elapsed_ms\":6}\n"
      << "  TCP: connect and read newline-delimited JSON, e.g. `nc HOST PORT`.\n"
      << "  UDP target: actively send packets, e.g. `--udp-target 127.0.0.1:5001`.\n"
      << "  UDP subscribe: bind a client port, send any datagram to --udp-port, then\n"
      << "       receive replies on that same client port; see udp_reader.py.\n"
      << "\n"
      << "Runtime keys in the preview window:\n"
      << "  q/Esc quit, +/- threshold, [/] process FPS, t fixed threshold,\n"
      << "  a auto threshold, b best threshold, r ring/simple mode\n"
      << "Preview trackbars:\n"
      << "  Threshold, Mode 0 raw/1 fixed/2 auto/3 best, Process FPS,\n"
      << "  Capture FPS request, Expected pairs\n";
}

bool parseArgs(int argc, char** argv, Options& options) {
  bool explicitCameras = false;
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
      explicitCameras = true;
    } else if (arg == "--cameras") {
      if (i + 1 >= argc) return false;
      options.cameras = parseCameraList(argv[++i]);
      explicitCameras = true;
    } else if (arg == "--max-camera-index") {
      if (!readInt(options.maxCameraIndex)) return false;
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
    } else if (arg == "--color-line-reader") {
      options.readerMode = ReaderMode::COLOR_LINE;
    } else if (arg == "--color-line-crop") {
      if (!readInt(options.colorLineCropPercent)) return false;
    } else if (arg == "--color-line-radial") {
      options.colorLineRadialScans = true;
    } else if (arg == "--robust-color") {
      options.robustColor = true;
    } else if (arg == "--tile-width") {
      if (!readInt(options.tileWidth)) return false;
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
    } else if (arg == "--separate-windows") {
      options.separateWindows = true;
    } else if (arg == "--angle-line") {
      options.angleLine = true;
    } else if (arg == "--angle-csv") {
      options.angleCsv = true;
    } else if (arg == "--tcp-port") {
      if (!readInt(options.tcpPort)) return false;
    } else if (arg == "--udp-port") {
      if (!readInt(options.udpPort)) return false;
    } else if (arg == "--udp-target") {
      if (i + 1 >= argc) return false;
      if (!parseHostPort(argv[++i], options.udpTargetHost, options.udpTargetPort)) return false;
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
  options.colorLineCropPercent = std::clamp(options.colorLineCropPercent, 5, 100);
  options.tileWidth = std::max(0, options.tileWidth);
  options.expectedPairs = std::max(1, options.expectedPairs);
  options.printEvery = std::max(1, options.printEvery);
  options.processFps = std::max(0.0, options.processFps);
  options.tcpPort = std::max(0, options.tcpPort);
  options.udpPort = std::max(0, options.udpPort);
  options.maxCameraIndex = std::max(0, options.maxCameraIndex);
  if (explicitCameras && options.cameras.empty()) options.cameras.push_back(options.camera);
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

  if (options.cameras.empty()) {
    options.cameras = detectConnectedCameras(options.maxCameraIndex);
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

  TelemetryServer telemetry;
  if (options.tcpPort > 0) {
    if (telemetry.startTcp(options.tcpPort)) {
      std::cerr << "telemetry: tcp listening on port " << options.tcpPort << "\n";
    } else {
      std::cerr << "telemetry: failed to start TCP server on port " << options.tcpPort << "\n";
      options.tcpPort = 0;
    }
  }
  if (options.udpPort > 0 || options.udpTargetPort > 0) {
    if (telemetry.startUdp(options.udpPort)) {
      if (options.udpPort > 0) {
        std::cerr << "telemetry: udp listening on port " << options.udpPort
                  << " (clients subscribe by sending any datagram)\n";
      } else {
        std::cerr << "telemetry: udp output socket ready\n";
      }
      if (options.udpTargetPort > 0) {
        if (!telemetry.addUdpTarget(options.udpTargetHost, options.udpTargetPort)) {
          std::cerr << "telemetry: invalid UDP target " << options.udpTargetHost
                    << ":" << options.udpTargetPort << "\n";
          options.udpTargetPort = 0;
        }
      }
    } else {
      std::cerr << "telemetry: failed to start UDP socket";
      if (options.udpPort > 0) std::cerr << " on port " << options.udpPort;
      std::cerr << "\n";
      options.udpPort = 0;
      options.udpTargetPort = 0;
    }
  }
  const bool telemetryEnabled = options.tcpPort > 0 || options.udpPort > 0 || options.udpTargetPort > 0;

  const bool gridWindow = cameras.size() > 1 && !options.separateWindows;
  const std::string controlsWindowName = gridWindow
      ? "basic fiducial native reader grid"
      : cameras.front().windowName;
  int thresholdTrack = options.threshold;
  int modeTrack = options.bestThreshold ? 3 : (options.autoThreshold ? 2 : (options.useThreshold ? 1 : 0));
  int processFpsTrack = static_cast<int>(std::round(options.processFps));
  int captureFpsTrack = options.fps > 0.0
      ? static_cast<int>(std::round(options.fps))
      : static_cast<int>(std::round(cameras.front().cap.get(cv::CAP_PROP_FPS)));
  int expectedPairsTrack = options.expectedPairs;
  for (auto& camera : cameras) camera.lastCaptureFpsTrack = captureFpsTrack;
  if (!options.noWindow) {
    if (gridWindow) {
      cv::namedWindow(controlsWindowName, cv::WINDOW_NORMAL);
    } else {
      for (const auto& camera : cameras) cv::namedWindow(camera.windowName, cv::WINDOW_NORMAL);
    }
    cv::createTrackbar("Threshold", controlsWindowName, &thresholdTrack, 255);
    cv::createTrackbar("Mode 0raw 1fix 2auto 3best", controlsWindowName, &modeTrack, 3);
    cv::createTrackbar("Process FPS 0=max", controlsWindowName, &processFpsTrack, 60);
    cv::createTrackbar("Capture FPS request", controlsWindowName, &captureFpsTrack, 60);
    cv::createTrackbar("Expected pairs", controlsWindowName, &expectedPairsTrack, 20);
  }

  auto nextFrameAt = std::chrono::steady_clock::now();
  while (true) {
    auto loopStart = std::chrono::steady_clock::now();
    if (telemetryEnabled) telemetry.poll();
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

    std::vector<CameraFrame> cameraFrames;
    std::vector<std::string> angleParts;
    const auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    for (auto& camera : cameras) {
      cv::Mat frame;
      if (!camera.cap.read(frame) || frame.empty()) {
        std::cerr << "camera=" << camera.index << " failed to read frame\n";
        continue;
      }

      auto result = processCameraFrame(frame, options);

      if (telemetryEnabled) {
        telemetry.broadcast(buildTelemetryJson(nowMs, camera.index, camera.frameNo, result, options.expectedPairs));
      }

      std::ostringstream ids;
      for (size_t i = 0; i < result.markers.size(); ++i) {
        if (i) ids << ",";
        ids << "#" << result.markers[i].id;
      }
      if (camera.frameNo % options.printEvery == 0) {
        std::ostringstream part;
        part << "cam" << camera.index << "=" << formatAngle(result.upAngle, 2)
             << "(" << result.pairs.size() << "/" << options.expectedPairs << ")";
        angleParts.push_back(part.str());

        if (options.angleCsv) {
          std::cout << nowMs << "," << camera.index << ","
                    << formatAngle(result.upAngle, 6) << ","
                    << result.pairs.size() << ","
                    << result.markers.size() << ","
                    << result.elapsedMs << "\n";
        } else if (!options.angleLine) {
          std::cout << "cam=" << camera.index
                    << "\t\tframe=" << camera.frameNo
                    << "\t\tms=" << result.elapsedMs
                    << "\t\tmarkers=" << result.markers.size()
                    << "\t\tpairs=" << result.pairs.size() << "/" << options.expectedPairs
                    << "\t\tangle=" << formatAngle(result.upAngle, 6)
                    << "\t\tids=" << ids.str();
          if (!result.thresholdSummary.empty()) std::cout << "\t\t" << result.thresholdSummary;
          std::cout << std::endl;
        }
      }
      camera.frameNo++;

      if (!options.noWindow) {
        if (options.readerMode == ReaderMode::COLOR_LINE) {
          drawColorLineOverlay(result.display, result);
        } else {
          drawOverlay(result.display, result.markers, result.pairs, result.upAngle, options.expectedPairs);
        }
        std::ostringstream hud;
        hud << "cam " << camera.index
            << " | cap " << camera.cap.get(cv::CAP_PROP_FPS)
            << " fps | proc " << (options.processFps > 0.0 ? std::to_string(options.processFps) : "max")
            << " | t=" << options.threshold
            << " | angle=" << formatAngle(result.upAngle, 2)
            << " | mode=" << (options.readerMode == ReaderMode::COLOR_LINE
                ? "color-line"
                : (options.bestThreshold ? "best" : (options.autoThreshold ? "auto" : (options.useThreshold ? "fixed" : "raw"))));
        cv::putText(result.display, hud.str(), {12, 24}, cv::FONT_HERSHEY_SIMPLEX, 0.55, {255, 255, 255}, 2, cv::LINE_AA);
        if (!gridWindow) cv::imshow(camera.windowName, result.display);
      }
      if (!options.noWindow && gridWindow) {
        cameraFrames.push_back({camera.index, camera.frameNo, camera.cap.get(cv::CAP_PROP_FPS), std::move(result)});
      }
    }

    if (options.angleLine && !angleParts.empty()) {
      std::cout << "\r";
      for (size_t i = 0; i < angleParts.size(); ++i) {
        if (i) std::cout << "\t\t";
        std::cout << angleParts[i];
      }
      std::cout << "        " << std::flush;
    }

    if (!options.noWindow) {
      if (gridWindow) {
        cv::Mat mosaic = composeMosaic(cameraFrames, options.tileWidth);
        if (!mosaic.empty()) cv::imshow(controlsWindowName, mosaic);
      }
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

  telemetry.stop();
  return 0;
}
