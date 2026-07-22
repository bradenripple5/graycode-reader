#!/usr/bin/env python3
import math
import time
import unittest

from native.calibration_bridge import (
    CalibrationState,
    arithmetic_average,
    average_angles_deg,
    least_squares_angle_estimate_deg,
)


class CalibrationEstimateTests(unittest.TestCase):
    def append_samples(self, state, joint, source, sensor, angle, received_times):
        with state.lock:
            for index, received_at_ms in enumerate(received_times):
                state.append_joint_reading(joint, {
                    "angle": angle,
                    "source": source,
                    "port_label": sensor,
                    "filter_time_ms": index * 1000,
                    "received_at_ms": received_at_ms,
                })

    def test_circular_average_handles_wraparound(self):
        angle = average_angles_deg([179.0, -179.0])
        self.assertAlmostEqual(abs(angle), 180.0, places=6)

    def test_arithmetic_average_uses_sum_divided_by_count(self):
        self.assertAlmostEqual(arithmetic_average([350.0, 10.0]), 180.0)

    def test_faster_sensor_has_proportionally_more_influence(self):
        now_ms = int(time.time() * 1000)
        state = CalibrationState(filter_tau_ms=1, fusion_fresh_ms=1000)
        self.append_samples(
            state, "wrist", "camera", "camera:6", 0.0,
            [now_ms - offset for offset in (400, 300, 200, 100, 0)],
        )
        self.append_samples(
            state, "wrist", "accel", "single:0x68", 90.0,
            [now_ms - offset for offset in (40, 30, 20, 10, 0)],
        )

        estimate = state.joint_estimates()["wrist"]
        sensors = {item["source"]: item for item in estimate["sensor_estimates"]}
        self.assertGreater(sensors["accel"]["data_rate_hz"], sensors["camera"]["data_rate_hz"])
        self.assertGreater(sensors["accel"]["weight"], sensors["camera"]["weight"])
        self.assertGreater(estimate["angle"], 60.0)

    def test_stale_accelerometer_is_excluded_and_camera_remains(self):
        now_ms = int(time.time() * 1000)
        state = CalibrationState(filter_tau_ms=1, fusion_fresh_ms=500)
        self.append_samples(
            state, "wrist", "accel", "single:0x68", 90.0,
            [now_ms - offset for offset in (1400, 1300, 1200, 1100, 1000)],
        )
        self.append_samples(
            state, "wrist", "camera", "camera:6", 20.0,
            [now_ms - offset for offset in (400, 300, 200, 100, 0)],
        )

        estimate = state.joint_estimates()["wrist"]
        self.assertEqual(estimate["source"], "camera")
        self.assertEqual(estimate["sensor_count"], 1)
        self.assertAlmostEqual(estimate["angle"], 20.0, places=3)

    def test_feed_timing_averages_last_ten_sample_intervals(self):
        state = CalibrationState()
        stats = None
        for sample_time_ms in range(0, 120, 10):
            stats = state.record_feed_timing(
                "accelerometer",
                "dual:0x68",
                sample_time_ms,
            )

        self.assertEqual(stats["timing_sample_count"], 10)
        self.assertAlmostEqual(stats["average_interval_ms"], 10.0)

    def test_camera_zero_maps_directly_to_base(self):
        state = CalibrationState(filter_tau_ms=1)
        state.push_packet({
            "camera": 0,
            "angle": 42.0,
            "codes": 11,
            "ring_positions": 19,
            "markers": 11,
        })

        self.assertAlmostEqual(state.latest_readings()["base"]["angle"], 42.0)
        self.assertEqual(state.latest_readings()["base"]["port_label"], "camera:0")
        self.assertNotIn("port_label", state.camera_feeds["0"])

    def test_aruco_frame_records_markers_with_latest_full_accelerometer_snapshot(self):
        state = CalibrationState()
        state.accelerometer_feeds["dual:0x68"] = {
            "angle": 12.5,
            "accel": {"x": 0.1, "y": 0.2, "z": 0.97},
            "gyro": {"x": 1.0, "y": 2.0, "z": 3.0},
            "temp_c": 24.0,
            "received_at_ms": 1010,
        }
        state.push_packet({
            "type": "aruco_pose",
            "ts_ms": 1000,
            "camera": 0,
            "frame": 7,
            "aruco_markers": [
                {"id": 0, "rvec": [0, 0, 0], "tvec": [0, 0, 1]},
                {"id": 9, "rvec": [0, 0, 0], "tvec": [0, 0, 2]},
            ],
        })

        sample = state.aruco_status(include_samples=True)["samples"][0]
        self.assertEqual(sample["frame"], 7)
        self.assertEqual([marker["id"] for marker in sample["markers"]], [0])
        self.assertEqual(sample["accelerometers"]["dual:0x68"]["accel"]["z"], 0.97)
        self.assertEqual(sample["accelerometers"]["dual:0x68"]["camera_delta_ms"], 10)

    def test_camera_zero_converts_signed_angle_to_360_range_before_capture(self):
        state = CalibrationState(filter_tau_ms=1)
        state.push_packet({
            "camera": 0,
            "angle": -172.628,
            "codes": 7,
            "ring_positions": 19,
            "markers": 7,
        })

        self.assertAlmostEqual(state.camera_feeds["0"]["average_angle_deg"], 187.372)
        self.assertAlmostEqual(state.latest_readings()["base"]["angle"], 187.372)
        self.assertAlmostEqual(
            state.capture()["row"]["udp_angles_deg"]["base"],
            187.372,
        )

    def test_camera_zero_base_uses_standard_average_and_preserves_360_range(self):
        state = CalibrationState(window_size=5, filter_tau_ms=1, fusion_fresh_ms=1000)
        now_ms = int(time.time() * 1000)
        self.append_samples(
            state, "base", "camera", "camera:0", 350.0,
            [now_ms - offset for offset in (40, 30, 20)],
        )
        self.append_samples(
            state, "base", "camera", "camera:0", 10.0,
            [now_ms - offset for offset in (10, 0)],
        )

        estimate = state.joint_estimates()["base"]
        self.assertAlmostEqual(estimate["angle"], 214.0, places=3)
        self.assertEqual(estimate["average_method"], "arithmetic")

    def test_camera_zero_feed_uses_standard_average(self):
        state = CalibrationState()
        state.record_feed_angle("camera", "0", 350.0, sample_time_ms=0)
        stats = state.record_feed_angle("camera", "0", 10.0, sample_time_ms=1)

        self.assertAlmostEqual(stats["average_angle_10_deg"], 180.0)
        self.assertEqual(stats["average_method"], "arithmetic")

    def test_feed_angle_averages_only_the_last_ten_samples(self):
        state = CalibrationState()
        stats = None
        for angle in range(12):
            stats = state.record_feed_angle("camera", "1", angle)

        self.assertEqual(stats["angle_sample_count_10"], 10)
        self.assertAlmostEqual(stats["average_angle_10_deg"], 6.5, places=6)
        self.assertNotIn("average_angle_100_deg", stats)

    def test_accelerometer_feed_has_last_ten_and_last_hundred_angle_averages(self):
        state = CalibrationState()
        stats = None
        for angle in range(110):
            stats = state.record_feed_angle("accelerometer", "dual:0x68", angle)

        self.assertEqual(stats["angle_sample_count_10"], 10)
        self.assertAlmostEqual(stats["average_angle_10_deg"], 104.5, places=6)
        self.assertEqual(stats["angle_sample_count_100"], 100)
        self.assertAlmostEqual(stats["average_angle_100_deg"], 59.5, places=6)

    def test_accelerometer_angle_averages_handle_wraparound(self):
        state = CalibrationState()
        stats = state.record_feed_angle("accelerometer", "dual:0x69", 179)
        stats = state.record_feed_angle("accelerometer", "dual:0x69", -179)

        self.assertAlmostEqual(abs(stats["average_angle_10_deg"]), 180.0, places=6)
        self.assertAlmostEqual(abs(stats["average_angle_100_deg"]), 180.0, places=6)

    def test_least_squares_angle_estimate_tracks_latest_linear_value(self):
        samples = [
            {"time_ms": index, "angle": 30.0 + index * 0.2}
            for index in range(10)
        ]
        estimate = least_squares_angle_estimate_deg(samples, degree=1)

        self.assertAlmostEqual(estimate, 31.8, places=6)

    def test_least_squares_angle_estimate_handles_wraparound(self):
        samples = [
            {"time_ms": index, "angle": angle}
            for index, angle in enumerate((178.0, 179.0, 180.0, -179.0, -178.0))
        ]
        estimate = least_squares_angle_estimate_deg(samples, degree=1)

        self.assertAlmostEqual(estimate, -178.0, places=6)

    def test_accelerometer_polynomial_uses_ten_samples_and_reduces_rest_noise(self):
        state = CalibrationState(accel_polynomial_window=10, accel_polynomial_degree=1)
        stats = None
        for index, angle in enumerate((29.5, 30.5) * 5):
            stats = state.record_feed_angle(
                "accelerometer",
                "dual:0x68",
                angle,
                sample_time_ms=index,
            )

        self.assertEqual(stats["polynomial_sample_count"], 10)
        self.assertEqual(stats["polynomial_window_size"], 10)
        self.assertEqual(stats["polynomial_degree"], 1)
        self.assertLess(abs(stats["polynomial_angle_deg"] - 30.0), 0.2)
        self.assertLess(
            abs(stats["polynomial_angle_deg"] - 30.0),
            abs(30.5 - 30.0),
        )

    def test_accelerometer_polynomial_waits_for_five_samples(self):
        state = CalibrationState(accel_polynomial_window=10)
        stats = None
        for index in range(4):
            stats = state.record_feed_angle(
                "accelerometer",
                "single:0x68",
                10.0,
                sample_time_ms=index,
            )
        self.assertIsNone(stats["polynomial_angle_deg"])

        stats = state.record_feed_angle(
            "accelerometer",
            "single:0x68",
            10.0,
            sample_time_ms=4,
        )
        self.assertAlmostEqual(stats["polynomial_angle_deg"], 10.0, places=6)

    def test_nano_feed_and_joint_filter_use_polynomial_estimate(self):
        state = CalibrationState(
            accel_polynomial_window=10,
            accel_polynomial_degree=1,
            filter_tau_ms=1,
        )
        for angle in (29.5, 30.5) * 5:
            radians = math.radians(angle)
            ax = round(math.sin(radians) * 16384)
            az = round(math.cos(radians) * 16384)
            state.push_nano_line(
                "dual",
                "/dev/test",
                f"A,68,{ax},0,{az},0,0,0",
            )

        feed = state.accelerometer_feeds["dual:0x68"]
        self.assertIsNotNone(feed["polynomial_angle_deg"])
        self.assertAlmostEqual(feed["angle"], feed["polynomial_angle_deg"], places=6)
        shoulder_history = next(iter(state.readings_by_sensor["shoulder"].values()))
        self.assertEqual(shoulder_history[-1]["polynomial_sample_count"], 10)
        self.assertEqual(shoulder_history[-1]["polynomial_degree"], 1)


if __name__ == "__main__":
    unittest.main()
