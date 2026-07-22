CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra -pthread
OPENCV_CFLAGS := $(shell pkg-config --cflags opencv4)
OPENCV_LIBS := $(shell pkg-config --libs opencv4)
BASH_COMPLETION_DIR ?= $(HOME)/.local/share/bash-completion/completions

all: basic_fiducial_reader grayscale_direction_reader aruco_pose_reader generate_aruco_markers

test: test_marker_angle
	./test_marker_angle

basic_fiducial_reader: basic_fiducial_reader.cpp
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $< -o $@ $(OPENCV_LIBS)

grayscale_direction_reader: grayscale_direction_reader.cpp
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $< -o $@ $(OPENCV_LIBS)

aruco_pose_reader: aruco_pose_reader.cpp
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $< -o $@ $(OPENCV_LIBS)

generate_aruco_markers: generate_aruco_markers.cpp
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $< -o $@ $(OPENCV_LIBS)

test_marker_angle: test_marker_angle.cpp basic_fiducial_reader.cpp
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $< -o $@ $(OPENCV_LIBS)

print-bash-completion:
	@cat completions/basic_fiducial_reader.bash

install-bash-completion:
	install -d "$(BASH_COMPLETION_DIR)"
	install -m 0644 completions/basic_fiducial_reader.bash "$(BASH_COMPLETION_DIR)/basic_fiducial_reader"

clean:
	rm -f basic_fiducial_reader grayscale_direction_reader aruco_pose_reader generate_aruco_markers test_marker_angle

.PHONY: all test print-bash-completion install-bash-completion clean
