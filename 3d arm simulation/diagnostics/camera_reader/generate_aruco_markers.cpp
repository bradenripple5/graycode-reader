#include <filesystem>
#include <fstream>
#include <iostream>
#include <opencv2/aruco.hpp>
#include <opencv2/opencv.hpp>
#include <string>

int main(int argc, char** argv) {
  const std::filesystem::path output = argc > 1 ? argv[1] : "aruco_markers";
  std::filesystem::create_directories(output);
  const auto dictionary = cv::aruco::getPredefinedDictionary(cv::aruco::DICT_4X4_50);
  constexpr int pixels = 600;
  constexpr int cells = 6;  // 4x4 payload plus the one-cell black border.
  constexpr double markerMm = 40.0;
  constexpr double cellMm = markerMm / cells;

  for (int id = 0; id <= 3; ++id) {
    cv::Mat marker;
    cv::aruco::drawMarker(dictionary, id, pixels, marker, 1);
    const auto filename = output / ("aruco_4x4_50_id_" + std::to_string(id) + "_40mm.svg");
    std::ofstream svg(filename);
    svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40mm\" height=\"46mm\" viewBox=\"0 0 40 46\">\n"
        << "<rect width=\"40\" height=\"46\" fill=\"white\"/>\n";
    for (int row = 0; row < cells; ++row) {
      for (int column = 0; column < cells; ++column) {
        const int y = row * pixels / cells + pixels / (cells * 2);
        const int x = column * pixels / cells + pixels / (cells * 2);
        if (marker.at<unsigned char>(y, x) < 128) {
          svg << "<rect x=\"" << column * cellMm << "\" y=\"" << row * cellMm
              << "\" width=\"" << cellMm << "\" height=\"" << cellMm
              << "\" fill=\"black\"/>\n";
        }
      }
    }
    svg << "<text x=\"20\" y=\"44.5\" text-anchor=\"middle\" font-family=\"sans-serif\" font-size=\"3.5\">"
        << "ID " << id << "</text>\n</svg>\n";
    std::cout << filename << '\n';
  }
  return 0;
}
