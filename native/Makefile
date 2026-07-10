CXX ?= g++
CXXFLAGS ?= -std=c++17 -O2 -Wall -Wextra
OPENCV_CFLAGS := $(shell pkg-config --cflags opencv4)
OPENCV_LIBS := $(shell pkg-config --libs opencv4)

all: basic_fiducial_reader

basic_fiducial_reader: basic_fiducial_reader.cpp
	$(CXX) $(CXXFLAGS) $(OPENCV_CFLAGS) $< -o $@ $(OPENCV_LIBS)

clean:
	rm -f basic_fiducial_reader

.PHONY: all clean
