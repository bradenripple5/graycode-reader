#define BASIC_FIDUCIAL_READER_NO_MAIN
#include "basic_fiducial_reader.cpp"

#include <cassert>

namespace {

double shortestAngleDistance(double left, double right) {
  double difference = normalizeDeg(left - right);
  return difference > 180.0 ? 360.0 - difference : difference;
}

Marker rotatedMarker(int id, double clockwiseDegrees) {
  constexpr float halfSize = 20.0f;
  const std::vector<cv::Point2f> canonical = {
    {-halfSize, -halfSize},
    {halfSize, -halfSize},
    {halfSize, halfSize},
    {-halfSize, halfSize},
  };
  const double radians = clockwiseDegrees * CV_PI / 180.0;
  const double cosine = std::cos(radians);
  const double sine = std::sin(radians);
  Marker marker;
  marker.id = id;
  marker.area = halfSize * halfSize * 4.0;
  for (const auto& point : canonical) {
    marker.corners.emplace_back(
        static_cast<float>(100.0 + point.x * cosine - point.y * sine),
        static_cast<float>(100.0 + point.x * sine + point.y * cosine));
  }
  return marker;
}

}  // namespace

int main() {
  constexpr int ringPositions = 19;
  constexpr double expectedUp = 123.4;
  const std::vector<int> ids = {18, 20, 22, 24};
  std::vector<MarkerAngle> readings;
  for (int id : ids) {
    const double imageRotation = normalizeDeg(markerFixedAngle(id, ringPositions) - expectedUp);
    auto reading = measureMarkerAngle(rotatedMarker(id, imageRotation), ringPositions);
    assert(reading);
    assert(shortestAngleDistance(reading->angle, expectedUp) < 1e-4);
    readings.push_back(*reading);
  }
  auto average = computeUpValue(readings);
  assert(average);
  assert(shortestAngleDistance(*average, expectedUp) < 1e-4);

  MarkerAngle beforeWrap;
  beforeWrap.angle = 359.0;
  beforeWrap.weight = 1.0;
  MarkerAngle afterWrap;
  afterWrap.angle = 1.0;
  afterWrap.weight = 1.0;
  average = computeUpValue({beforeWrap, afterWrap});
  assert(average);
  assert(shortestAngleDistance(*average, 0.0) < 1e-9);
  return 0;
}
