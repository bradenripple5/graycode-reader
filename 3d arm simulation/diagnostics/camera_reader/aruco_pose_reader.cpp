#include <arpa/inet.h>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <netinet/in.h>
#include <opencv2/aruco.hpp>
#include <opencv2/opencv.hpp>
#include <sstream>
#include <string>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {

volatile std::sig_atomic_t running = 1;

struct Options {
  int camera = 0;
  int width = 1280;
  int height = 720;
  double fps = 30.0;
  double processFps = 10.0;
  double markerLengthM = 0.04;
  std::string calibrationFile;
  std::string udpHost = "127.0.0.1";
  int udpPort = 5010;
  bool noWindow = false;
};

void onSignal(int) { running = 0; }

int64_t epochMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
}

bool parseTarget(const std::string& value, std::string& host, int& port) {
  const auto separator = value.rfind(':');
  if (separator == std::string::npos) return false;
  host = value.substr(0, separator);
  try { port = std::stoi(value.substr(separator + 1)); } catch (...) { return false; }
  return !host.empty() && port > 0 && port <= 65535;
}

void usage(const char* program) {
  std::cout
    << "Usage: " << program << " [options]\n"
    << "  --camera N                 V4L2 camera index (default 0)\n"
    << "  --width N --height N       capture size (default 1280x720)\n"
    << "  --fps N                    requested capture FPS (default 30)\n"
    << "  --process-fps N            ArUco processing FPS (default 10)\n"
    << "  --marker-length M          printed marker side in meters (default 0.04)\n"
    << "  --camera-calibration FILE  OpenCV YAML with camera_matrix and distortion_coefficients\n"
    << "  --udp-target HOST:PORT     calibration bridge (default 127.0.0.1:5010)\n"
    << "  --no-window                run headless\n";
}

bool parseArgs(int argc, char** argv, Options& options) {
  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    auto next = [&]() -> const char* {
      return ++index < argc ? argv[index] : nullptr;
    };
    const char* value = nullptr;
    if (arg == "--camera" && (value = next())) options.camera = std::atoi(value);
    else if (arg == "--width" && (value = next())) options.width = std::atoi(value);
    else if (arg == "--height" && (value = next())) options.height = std::atoi(value);
    else if (arg == "--fps" && (value = next())) options.fps = std::atof(value);
    else if (arg == "--process-fps" && (value = next())) options.processFps = std::atof(value);
    else if (arg == "--marker-length" && (value = next())) options.markerLengthM = std::atof(value);
    else if (arg == "--camera-calibration" && (value = next())) options.calibrationFile = value;
    else if (arg == "--udp-target" && (value = next())) {
      if (!parseTarget(value, options.udpHost, options.udpPort)) return false;
    } else if (arg == "--no-window") options.noWindow = true;
    else if (arg == "--help" || arg == "-h") { usage(argv[0]); std::exit(0); }
    else { std::cerr << "Unknown or incomplete option: " << arg << "\n"; return false; }
  }
  return options.width > 0 && options.height > 0 && options.markerLengthM > 0.0;
}

bool loadIntrinsics(const Options& options, cv::Mat& cameraMatrix, cv::Mat& distortion) {
  if (!options.calibrationFile.empty()) {
    cv::FileStorage storage(options.calibrationFile, cv::FileStorage::READ);
    if (storage.isOpened()) {
      storage["camera_matrix"] >> cameraMatrix;
      storage["distortion_coefficients"] >> distortion;
      if (!cameraMatrix.empty() && !distortion.empty()) return true;
    }
    std::cerr << "Could not load camera intrinsics from " << options.calibrationFile << "\n";
  }
  const double focal = static_cast<double>(std::max(options.width, options.height));
  cameraMatrix = (cv::Mat_<double>(3, 3) <<
    focal, 0.0, options.width * 0.5,
    0.0, focal, options.height * 0.5,
    0.0, 0.0, 1.0);
  distortion = cv::Mat::zeros(1, 5, CV_64F);
  return false;
}

std::string vectorJson(const cv::Vec3d& value) {
  std::ostringstream out;
  out << '[' << std::fixed << std::setprecision(8)
      << value[0] << ',' << value[1] << ',' << value[2] << ']';
  return out.str();
}

std::string cornersJson(const std::vector<cv::Point2f>& corners) {
  std::ostringstream out;
  out << '[';
  for (size_t index = 0; index < corners.size(); ++index) {
    if (index) out << ',';
    out << '[' << std::fixed << std::setprecision(3)
        << corners[index].x << ',' << corners[index].y << ']';
  }
  out << ']';
  return out.str();
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  if (!parseArgs(argc, argv, options)) { usage(argv[0]); return 2; }
  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  cv::VideoCapture camera(options.camera, cv::CAP_V4L2);
  if (!camera.isOpened()) {
    std::cerr << "Could not open camera " << options.camera << "\n";
    return 1;
  }
  camera.set(cv::CAP_PROP_FRAME_WIDTH, options.width);
  camera.set(cv::CAP_PROP_FRAME_HEIGHT, options.height);
  camera.set(cv::CAP_PROP_FPS, options.fps);

  cv::Mat cameraMatrix, distortion;
  const bool calibratedIntrinsics = loadIntrinsics(options, cameraMatrix, distortion);
  if (!calibratedIntrinsics) {
    std::cerr << "WARNING: using approximate intrinsics; translation is diagnostic only.\n";
  }

  const int socketFd = ::socket(AF_INET, SOCK_DGRAM, 0);
  if (socketFd < 0) return 1;
  sockaddr_in target{};
  target.sin_family = AF_INET;
  target.sin_port = htons(static_cast<uint16_t>(options.udpPort));
  if (::inet_pton(AF_INET, options.udpHost.c_str(), &target.sin_addr) != 1) {
    std::cerr << "UDP host must be an IPv4 address\n";
    ::close(socketFd);
    return 2;
  }

  const auto dictionary = cv::aruco::getPredefinedDictionary(cv::aruco::DICT_4X4_50);
  const auto parameters = cv::aruco::DetectorParameters::create();
  parameters->cornerRefinementMethod = cv::aruco::CORNER_REFINE_SUBPIX;
  int frameNumber = 0;
  auto nextFrame = std::chrono::steady_clock::now();

  while (running) {
    cv::Mat frame;
    if (!camera.read(frame) || frame.empty()) continue;
    const int64_t capturedAtMs = epochMs();
    const auto now = std::chrono::steady_clock::now();
    if (options.processFps > 0.0 && now < nextFrame) continue;
    if (options.processFps > 0.0) {
      nextFrame = now + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
        std::chrono::duration<double>(1.0 / options.processFps));
    }

    std::vector<int> ids;
    std::vector<std::vector<cv::Point2f>> corners, rejected;
    cv::aruco::detectMarkers(frame, dictionary, corners, ids, parameters, rejected);
    std::vector<cv::Vec3d> rvecs, tvecs;
    if (!ids.empty()) {
      cv::aruco::estimatePoseSingleMarkers(
        corners, static_cast<float>(options.markerLengthM), cameraMatrix, distortion, rvecs, tvecs);
    }

    std::ostringstream payload;
    payload << "{\"type\":\"aruco_pose\",\"ts_ms\":" << capturedAtMs
            << ",\"camera\":" << options.camera
            << ",\"frame\":" << frameNumber
            << ",\"marker_length_m\":" << options.markerLengthM
            << ",\"intrinsics_approximate\":" << (calibratedIntrinsics ? "false" : "true")
            << ",\"aruco_markers\":[";
    bool first = true;
    for (size_t index = 0; index < ids.size(); ++index) {
      if (ids[index] < 0 || ids[index] > 3) continue;
      if (!first) payload << ',';
      first = false;
      payload << "{\"id\":" << ids[index]
              << ",\"rvec\":" << vectorJson(rvecs[index])
              << ",\"tvec\":" << vectorJson(tvecs[index])
              << ",\"corners_px\":" << cornersJson(corners[index]) << '}';
    }
    payload << "]}";
    const std::string message = payload.str();
    ::sendto(socketFd, message.data(), message.size(), 0,
      reinterpret_cast<sockaddr*>(&target), sizeof(target));

    if (!options.noWindow) {
      cv::aruco::drawDetectedMarkers(frame, corners, ids);
      for (size_t index = 0; index < ids.size(); ++index) {
        if (ids[index] >= 0 && ids[index] <= 3) {
          cv::drawFrameAxes(frame, cameraMatrix, distortion, rvecs[index], tvecs[index],
            static_cast<float>(options.markerLengthM * 0.65), 2);
        }
      }
      cv::imshow("ArUco arm calibration IDs 0-3", frame);
      const int key = cv::waitKey(1);
      if (key == 27 || key == 'q') running = 0;
    }
    ++frameNumber;
  }

  ::close(socketFd);
  return 0;
}
