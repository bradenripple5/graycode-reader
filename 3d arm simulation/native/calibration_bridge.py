#!/usr/bin/env python3
import argparse
import json
import math
import os
import socket
import termios
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import serial


DEFAULT_JOINT_BY_PORT = {
    "usb-0:1.2.1": "shoulder",
    "usb-0:1.2.2": "elbow",
    "usb-0:1.2.3": "wrist",
    "usb-0:1.2.4": "base",
}
CALIBRATION_TARGETS_DEG = {
    "base": 0,
    "shoulder": 0,
    "elbow": 0,
    "wrist": 0,
}
CALIBRATION_JOINTS = ["base", "shoulder", "elbow", "wrist"]
EXTRA_SENSOR_KEYS = ["wrist_camera", "wrist_accel", "clamp"]
DEFAULT_NANO_JOINTS = {
    ("dual", "0x68"): "shoulder",
    ("dual", "0x69"): "elbow",
    ("single", "0x68"): "wrist",
}
MAX_NANO_STATUS_LINE_CHARS = 512


def normalize_angle_180(value):
    result = math.fmod(value, 360.0)
    if result > 180.0:
        result -= 360.0
    if result <= -180.0:
        result += 360.0
    return result


def normalize_vec(vec):
    mag = math.sqrt(sum(item * item for item in vec))
    if mag <= 0:
        return [0.0, 0.0, 0.0]
    return [item / mag for item in vec]


def angle_from_accel_signed(accel, ref_vec=(0.0, 0.0, 1.0), normal_vec=(0.0, 1.0, 0.0)):
    v = normalize_vec([accel["x"], accel["y"], accel["z"]])
    v0 = normalize_vec(ref_vec)
    n = normalize_vec(normal_vec)
    cross = [
        v0[1] * v[2] - v0[2] * v[1],
        v0[2] * v[0] - v0[0] * v[2],
        v0[0] * v[1] - v0[1] * v[0],
    ]
    sin_term = sum(cross[i] * n[i] for i in range(3))
    cos_term = sum(v0[i] * v[i] for i in range(3))
    return math.degrees(math.atan2(sin_term, cos_term))


def fuse_angles_deg(samples):
    x = 0.0
    y = 0.0
    weight_sum = 0.0
    for sample in samples:
        if not sample:
            continue
        try:
            angle = float(sample["angle"])
            weight = float(sample["weight"])
        except (KeyError, TypeError, ValueError):
            continue
        if weight <= 0:
            continue
        radians = math.radians(angle)
        x += math.cos(radians) * weight
        y += math.sin(radians) * weight
        weight_sum += weight
    if weight_sum <= 0:
        return None
    return normalize_angle_180(math.degrees(math.atan2(y, x)))


def parse_dual_sensor_line(line):
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 13 or parts[1] != "SAMPLE":
        return None
    try:
        device_ms = float(parts[0])
        mpu_ok = parts[2] == "1"
        ax = float(parts[3])
        ay = float(parts[4])
        az = float(parts[5])
        temp_c = float(parts[6])
        gx = float(parts[7])
        gy = float(parts[8])
        gz = float(parts[9])
        as5600_ok = parts[10] == "1"
        raw_angle = int(float(parts[11]))
        as5600_degrees = float(parts[12])
    except (TypeError, ValueError):
        return None

    accel = {"x": ax, "y": ay, "z": az}
    return {
        "type": "dual_sensor",
        "device_ms": device_ms,
        "mpu_ok": mpu_ok,
        "wrist_accel": {
            "angle": angle_from_accel_signed(accel) if mpu_ok else None,
            "accel": accel,
            "gyro": {"x": gx, "y": gy, "z": gz},
            "temp_c": temp_c,
        },
        "as5600_ok": as5600_ok,
        "clamp": {
            "angle": as5600_degrees if as5600_ok else None,
            "raw_angle": raw_angle if as5600_ok else None,
        },
    }


def parse_compact_mpu_line(line):
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 8 or parts[0] != "A":
        return None
    try:
        address = f"0x{int(parts[1], 16):02x}"
        ax, ay, az = (float(parts[index]) / 16384.0 for index in range(2, 5))
        gx, gy, gz = (float(parts[index]) / 131.0 for index in range(5, 8))
    except (TypeError, ValueError):
        return None
    accel = {"x": ax, "y": ay, "z": az}
    return {
        "type": "compact_mpu",
        "address": address,
        "angle": angle_from_accel_signed(accel),
        "accel": accel,
        "gyro": {"x": gx, "y": gy, "z": gz},
    }


def parse_single_mpu_line(line):
    parts = [part.strip() for part in line.split(",")]
    if len(parts) != 8:
        return None
    try:
        device_ms = float(parts[0])
        ax, ay, az = (float(parts[index]) for index in range(1, 4))
        temp_c = float(parts[4])
        gx, gy, gz = (float(parts[index]) for index in range(5, 8))
    except (TypeError, ValueError):
        return None
    if max(abs(ax), abs(ay), abs(az)) > 4.0 or not -50.0 <= temp_c <= 150.0:
        return None
    accel = {"x": ax, "y": ay, "z": az}
    return {
        "type": "single_mpu",
        "address": "0x68",
        "device_ms": device_ms,
        "angle": angle_from_accel_signed(accel),
        "accel": accel,
        "gyro": {"x": gx, "y": gy, "z": gz},
        "temp_c": temp_c,
    }


def parse_addressed_mpu_line(line):
    parts = [part.strip() for part in line.split(",")]
    if len(parts) != 9 or not parts[1].lower().startswith("0x"):
        return None
    try:
        device_ms = float(parts[0])
        address = f"0x{int(parts[1], 16):02x}"
        ax, ay, az = (float(parts[index]) for index in range(2, 5))
        temp_c = float(parts[5])
        gx, gy, gz = (float(parts[index]) for index in range(6, 9))
    except (TypeError, ValueError):
        return None
    accel = {"x": ax, "y": ay, "z": az}
    return {
        "type": "addressed_mpu",
        "address": address,
        "device_ms": device_ms,
        "angle": angle_from_accel_signed(accel),
        "accel": accel,
        "gyro": {"x": gx, "y": gy, "z": gz},
        "temp_c": temp_c,
    }


def normalized_targets(targets):
    result = dict(CALIBRATION_TARGETS_DEG)
    if not isinstance(targets, dict):
        return result
    for joint in CALIBRATION_JOINTS:
        try:
            result[joint] = float(targets[joint])
        except (KeyError, TypeError, ValueError):
            pass
    return result


class CalibrationState:
    def __init__(
        self,
        joint_by_port=None,
        window_size=10,
        wrist_accel_weight=0.3,
        wrist_camera_weight=0.7,
        fusion_fresh_ms=500,
        filter_tau_ms=180,
    ):
        self.joint_by_port = dict(joint_by_port or DEFAULT_JOINT_BY_PORT)
        self.window_size = window_size
        self.wrist_accel_weight = wrist_accel_weight
        self.wrist_camera_weight = wrist_camera_weight
        self.fusion_fresh_ms = fusion_fresh_ms
        self.filter_tau_ms = max(1.0, float(filter_tau_ms))
        self.filter_state = {}
        self.accel_angle_history = {}
        self.readings_by_joint = {joint: deque(maxlen=window_size) for joint in CALIBRATION_JOINTS}
        self.extra_readings = {key: None for key in EXTRA_SENSOR_KEYS}
        self.nanos = {}
        self.camera_feeds = {}
        self.accelerometer_feeds = {}
        self.rows = []
        self.calibration_reference = None
        self.last_packet = None
        self.last_nano_packet = None
        self.udp_error = None
        self.nano_errors = {}
        self.lock = threading.Lock()
        self.update_condition = threading.Condition(self.lock)
        self.update_version = 0

    def append_joint_reading(self, joint, reading):
        reading = dict(reading)
        source = reading.get("source", "unknown")
        key = (joint, source)
        now_ms = float(reading.get("filter_time_ms", reading.get("received_at_ms", time.time() * 1000)))
        raw_angle = normalize_angle_180(float(reading["angle"]))
        previous = self.filter_state.get(key)

        measurement = raw_angle
        if source == "accel":
            history = self.accel_angle_history.setdefault(key, deque(maxlen=3))
            if previous:
                unwrapped = previous["angle"] + normalize_angle_180(raw_angle - previous["angle"])
            else:
                unwrapped = raw_angle
            history.append(unwrapped)
            measurement = normalize_angle_180(sorted(history)[len(history) // 2])

        if previous is None:
            filtered_angle = measurement
            sample_hz = None
        else:
            dt_ms = max(0.1, now_ms - previous["received_at_ms"])
            dt_seconds = dt_ms / 1000.0
            gyro_rate = float(reading.get("gyro_rate", 0.0) or 0.0)
            predicted = normalize_angle_180(previous["angle"] + gyro_rate * dt_seconds)
            correction = 1.0 - math.exp(-dt_ms / self.filter_tau_ms)
            error = normalize_angle_180(measurement - predicted)
            filtered_angle = normalize_angle_180(predicted + correction * error)
            instantaneous_hz = 1000.0 / dt_ms
            old_hz = previous.get("sample_hz")
            sample_hz = instantaneous_hz if old_hz is None else old_hz * 0.9 + instantaneous_hz * 0.1

        reading["raw_angle"] = raw_angle
        reading["angle"] = filtered_angle
        reading["sample_hz"] = sample_hz
        self.filter_state[key] = {
            "angle": filtered_angle,
            "received_at_ms": now_ms,
            "sample_hz": sample_hz,
        }
        self.readings_by_joint[joint].append(reading)
        self.update_version += 1
        self.update_condition.notify_all()
        return reading

    def wait_for_update(self, previous_version, timeout=15.0):
        with self.update_condition:
            self.update_condition.wait_for(
                lambda: self.update_version != previous_version,
                timeout=timeout,
            )
            return self.update_version

    def stream_snapshot(self, source_mode="both"):
        status = self.status("", 0, source_mode)
        return {
            "ok": True,
            "source_mode": source_mode,
            "filter_tau_ms": self.filter_tau_ms,
            "sent_at_ms": int(time.time() * 1000),
            "latest": status["latest"],
            "averages": status["averages"],
            "accelerometers": {
                "nanos": status["nanos"],
                "feeds": status["accelerometer_feeds"],
                "last_packet": status["nano"]["last_packet"],
                "errors": status["nano"]["errors"],
            },
            "camera_feeds": status["camera_feeds"],
            "calibration_reference": status["calibration_reference"],
        }

    def push_packet(self, payload):
        port_label = str(payload.get("port_label") or "")
        joint = self.joint_by_port.get(port_label)
        now_ms = int(time.time() * 1000)
        with self.lock:
            camera = payload.get("camera")
            camera_key = str(camera) if camera is not None else "unknown"
            self.camera_feeds[camera_key] = {
                "camera": camera,
                "port_label": port_label,
                "angle": payload.get("angle"),
                "pairs": payload.get("pairs"),
                "expected_pairs": payload.get("expected_pairs"),
                "markers": payload.get("markers"),
                "elapsed_ms": payload.get("elapsed_ms"),
                "frame": payload.get("frame"),
                "received_at_ms": now_ms,
            }
            self.last_packet = {
                **payload,
                "joint": joint,
                "received_at_ms": now_ms,
            }
            if not joint:
                return
            angle = payload.get("angle")
            try:
                angle = float(angle)
            except (TypeError, ValueError):
                return
            self.append_joint_reading(joint, {
                "angle": angle,
                "source": "camera",
                "camera": payload.get("camera"),
                "port_label": port_label,
                "ts_ms": payload.get("ts_ms", now_ms),
                "filter_time_ms": payload.get("ts_ms", now_ms),
                "received_at_ms": now_ms,
            })
            if joint == "wrist":
                self.extra_readings["wrist_camera"] = {
                    "angle": angle,
                    "camera": payload.get("camera"),
                    "port_label": port_label,
                    "ts_ms": payload.get("ts_ms", now_ms),
                    "received_at_ms": now_ms,
                }

    def push_nano_line(self, name, port, line):
        now_ms = int(time.time() * 1000)
        status_line = line
        if len(status_line) > MAX_NANO_STATUS_LINE_CHARS:
            status_line = f"{status_line[:MAX_NANO_STATUS_LINE_CHARS]}… [truncated]"
        parsed = (
            parse_dual_sensor_line(line)
            or parse_compact_mpu_line(line)
            or parse_addressed_mpu_line(line)
            or parse_single_mpu_line(line)
        )
        with self.lock:
            nano = self.nanos.setdefault(name, {"name": name, "port": port})
            recent_lines = nano.setdefault("recent_lines", [])
            recent_lines.append({"line": status_line, "received_at_ms": now_ms})
            del recent_lines[:-20]
            nano.update({
                "name": name,
                "port": port,
                "last_line": status_line,
                "received_at_ms": now_ms,
            })
            if parsed:
                nano["parsed"] = parsed
                address = parsed.get("address")
                feed_key = f"{name}:{address}" if address else name
                self.accelerometer_feeds[feed_key] = {
                    "name": name,
                    "port": port,
                    "address": address,
                    "type": parsed.get("type"),
                    "angle": parsed.get("angle"),
                    "accel": parsed.get("accel"),
                    "gyro": parsed.get("gyro"),
                    "temp_c": parsed.get("temp_c"),
                    "mpu_ok": parsed.get("mpu_ok"),
                    "received_at_ms": now_ms,
                }
                if parsed["type"] in {"compact_mpu", "addressed_mpu", "single_mpu"}:
                    joint = DEFAULT_NANO_JOINTS.get((name, parsed["address"]))
                    if joint:
                        self.append_joint_reading(joint, {
                            "angle": float(parsed["angle"]),
                            "gyro_rate": float((parsed.get("gyro") or {}).get("y", 0.0)),
                            "source": "accel",
                            "camera": None,
                            "port_label": f"{name}:{parsed['address']}",
                            "ts_ms": now_ms,
                            "filter_time_ms": parsed.get("device_ms", now_ms),
                            "received_at_ms": now_ms,
                        })
                wrist_accel = parsed.get("wrist_accel") or {}
                if parsed.get("mpu_ok") and wrist_accel.get("angle") is not None:
                    wrist_reading = {
                        "angle": float(wrist_accel["angle"]),
                        "accel": wrist_accel.get("accel"),
                        "gyro": wrist_accel.get("gyro"),
                        "temp_c": wrist_accel.get("temp_c"),
                        "nano": name,
                        "port": port,
                        "device_ms": parsed.get("device_ms"),
                        "received_at_ms": now_ms,
                    }
                    filtered_wrist = self.append_joint_reading("wrist", {
                        "angle": wrist_reading["angle"],
                        "gyro_rate": float((wrist_accel.get("gyro") or {}).get("y", 0.0)),
                        "source": "accel",
                        "camera": None,
                        "port_label": f"{name}:0x68",
                        "ts_ms": now_ms,
                        "filter_time_ms": parsed.get("device_ms", now_ms),
                        "received_at_ms": now_ms,
                    })
                    wrist_reading["raw_angle"] = filtered_wrist["raw_angle"]
                    wrist_reading["angle"] = filtered_wrist["angle"]
                    wrist_reading["sample_hz"] = filtered_wrist["sample_hz"]
                    self.extra_readings["wrist_accel"] = wrist_reading
                clamp = parsed.get("clamp") or {}
                if parsed.get("as5600_ok") and clamp.get("angle") is not None:
                    self.extra_readings["clamp"] = {
                        "angle": float(clamp["angle"]),
                        "raw_angle": clamp.get("raw_angle"),
                        "nano": name,
                        "port": port,
                        "device_ms": parsed.get("device_ms"),
                        "received_at_ms": now_ms,
                    }
            self.last_nano_packet = {
                "name": name,
                "port": port,
                "line": line,
                "parsed": parsed,
                "received_at_ms": now_ms,
            }

    def set_nano_error(self, name, error):
        with self.lock:
            self.nano_errors[name] = error

    def set_nano_connected(self, name, port, baud):
        now_ms = int(time.time() * 1000)
        with self.lock:
            nano = self.nanos.setdefault(name, {"name": name, "port": port})
            nano.update({
                "name": name,
                "port": port,
                "baud": baud,
                "connected_at_ms": now_ms,
            })

    def averages(self, source_mode="both"):
        now_ms = int(time.time() * 1000)
        result = {}
        with self.lock:
            for joint in CALIBRATION_JOINTS:
                readings = [
                    item for item in self.readings_by_joint[joint]
                    if source_mode == "both" or item.get("source") == source_mode
                ]
                if not readings:
                    result[joint] = None
                    continue
                latest = readings[-1]
                result[joint] = {
                    "angle": sum(item["angle"] for item in readings) / len(readings),
                    "count": len(readings),
                    "camera": latest.get("camera"),
                    "port_label": latest.get("port_label", ""),
                    "age_ms": now_ms - int(latest.get("received_at_ms", now_ms)),
                }
        return result

    def latest_readings(self, source_mode="both"):
        now_ms = int(time.time() * 1000)
        result = {}
        with self.lock:
            for joint in CALIBRATION_JOINTS:
                readings = [
                    item for item in self.readings_by_joint[joint]
                    if source_mode == "both" or item.get("source") == source_mode
                ]
                if not readings:
                    result[joint] = None
                    continue
                latest = readings[-1]
                result[joint] = {
                    "angle": latest["angle"],
                    "raw_angle": latest.get("raw_angle", latest["angle"]),
                    "sample_hz": latest.get("sample_hz"),
                    "camera": latest.get("camera"),
                    "port_label": latest.get("port_label", ""),
                    "age_ms": now_ms - int(latest.get("received_at_ms", now_ms)),
                }
            extras = {
                key: dict(value) if value else None
                for key, value in self.extra_readings.items()
            }

        for key, value in extras.items():
            if not value:
                result[key] = None
                continue
            value["age_ms"] = now_ms - int(value.get("received_at_ms", now_ms))
            result[key] = value

        camera = result.get("wrist_camera") if source_mode in {"camera", "both"} else None
        accel = result.get("wrist_accel") if source_mode in {"accel", "both"} else None
        fresh_ms = self.fusion_fresh_ms
        fused_angle = fuse_angles_deg([
            {
                "angle": camera["angle"],
                "weight": self.wrist_camera_weight,
            }
            if camera and camera.get("age_ms", fresh_ms + 1) <= fresh_ms
            else None,
            {
                "angle": accel["angle"],
                "weight": self.wrist_accel_weight,
            }
            if accel and accel.get("age_ms", fresh_ms + 1) <= fresh_ms
            else None,
        ])
        if fused_angle is not None:
            result["wrist"] = {
                "angle": fused_angle,
                "source": "camera+mpu6050",
                "camera_angle": camera.get("angle") if camera else None,
                "accel_angle": accel.get("angle") if accel else None,
                "raw_angle": accel.get("raw_angle") if accel else (camera.get("angle") if camera else None),
                "sample_hz": accel.get("sample_hz") if accel else None,
                "age_ms": min(
                    [
                        item.get("age_ms", fresh_ms)
                        for item in (camera, accel)
                        if item is not None
                    ]
                    or [0]
                ),
            }
        return result

    def status(self, udp_host, udp_port, source_mode="both"):
        with self.lock:
            rows = list(self.rows)
            calibration_reference = dict(self.calibration_reference) if self.calibration_reference else None
            if calibration_reference and calibration_reference.get("source_mode", "both") != source_mode:
                calibration_reference = None
            last_packet = dict(self.last_packet) if self.last_packet else None
            last_nano_packet = dict(self.last_nano_packet) if self.last_nano_packet else None
            udp_error = self.udp_error
            nanos = {name: dict(value) for name, value in self.nanos.items()}
            camera_feeds = {key: dict(value) for key, value in self.camera_feeds.items()}
            accelerometer_feeds = {key: dict(value) for key, value in self.accelerometer_feeds.items()}
            nano_errors = dict(self.nano_errors)
        return {
            "ok": True,
            "source_mode": source_mode,
            "filter_tau_ms": self.filter_tau_ms,
            "udp": {
                "host": udp_host,
                "port": udp_port,
                "error": udp_error,
            },
            "nano": {
                "errors": nano_errors,
                "last_packet": last_nano_packet,
            },
            "nanos": nanos,
            "camera_feeds": camera_feeds,
            "accelerometer_feeds": accelerometer_feeds,
            "joint_by_port": self.joint_by_port,
            "targets_deg": CALIBRATION_TARGETS_DEG,
            "averages": self.averages(source_mode),
            "latest": self.latest_readings(source_mode),
            "rows": rows,
            "calibration_reference": calibration_reference,
            "last_packet": last_packet,
        }

    def capture(self, label="", targets_deg=None, source_mode="both"):
        averages = self.averages(source_mode)
        latest = self.latest_readings(source_mode)
        targets = normalized_targets(targets_deg)
        row = {
            "id": int(time.time() * 1000),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "label": label,
            "source_mode": source_mode,
            "targets_deg": targets,
            "udp_angles_deg": {
                joint: (latest[joint]["angle"] if latest.get(joint) else None)
                for joint in CALIBRATION_JOINTS
            },
            "udp_average_deg": {
                joint: (averages[joint]["angle"] if averages.get(joint) else None)
                for joint in CALIBRATION_JOINTS
            },
            "sample_counts": {
                joint: (averages[joint]["count"] if averages.get(joint) else 0)
                for joint in CALIBRATION_JOINTS
            },
            "port_labels": {
                joint: (averages[joint]["port_label"] if averages.get(joint) else "")
                for joint in CALIBRATION_JOINTS
            },
            "sensor_readings": latest,
            "sensor_averages": averages,
        }
        with self.lock:
            self.rows.append(row)
            self.calibration_reference = row
            rows = list(self.rows)
        return {
            "ok": True,
            "source_mode": source_mode,
            "row": row,
            "rows": rows,
            "calibration_reference": row,
            "latest": latest,
            "averages": averages,
            "targets_deg": CALIBRATION_TARGETS_DEG,
        }

    def uncalibrate(self, udp_host, udp_port, source_mode="both"):
        with self.lock:
            self.calibration_reference = None
        return self.status(udp_host, udp_port, source_mode)

    def clear_calibration(self, udp_host, udp_port, source_mode="both"):
        with self.lock:
            self.rows = []
            self.calibration_reference = None
        return self.status(udp_host, udp_port, source_mode)


def run_udp_listener(state, host, port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((host, port))
    while True:
        try:
            data, _addr = sock.recvfrom(65535)
            for line in data.decode("utf-8", "replace").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    state.push_packet(json.loads(line))
                except json.JSONDecodeError as exc:
                    with state.lock:
                        state.udp_error = str(exc)
        except OSError as exc:
            with state.lock:
                state.udp_error = str(exc)


def parse_nano_spec(value, default_baud):
    if ":" not in value:
        name = f"nano{abs(hash(value)) % 10000}"
        return name, value, default_baud
    name, port = value.split(":", 1)
    name = name.strip()
    port = port.strip()
    baud = default_baud
    if "@" in name:
        name, baud_text = name.rsplit("@", 1)
        try:
            baud = int(baud_text)
        except ValueError as exc:
            raise ValueError(f"invalid Nano baud in {value!r}") from exc
    if not name or not port:
        raise ValueError(f"invalid nano spec {value!r}; use name@baud:/dev/ttyUSB0")
    return name, port, baud


def configure_serial(fd, baud):
    baud_map = {
        9600: termios.B9600,
        19200: termios.B19200,
        38400: termios.B38400,
        57600: termios.B57600,
        115200: termios.B115200,
        230400: termios.B230400,
        250000: termios.B250000,
        500000: termios.B500000,
    }
    if baud not in baud_map:
        raise ValueError(f"unsupported baud {baud}; use one of {sorted(baud_map)}")
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CLOCAL | termios.CREAD | termios.CS8
    attrs[3] = 0
    attrs[4] = baud_map[baud]
    attrs[5] = baud_map[baud]
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 10
    termios.tcsetattr(fd, termios.TCSANOW, attrs)


def run_nano_reader(state, name, port, baud):
    while True:
        device = None
        try:
            device = serial.Serial(port, baud, timeout=0.1)
            state.set_nano_connected(name, port, baud)
            state.set_nano_error(name, None)
            buffer = b""
            last_data_at = time.monotonic()
            while True:
                chunk = device.read(1024)
                if not chunk:
                    if time.monotonic() - last_data_at > 3.0:
                        raise serial.SerialException("no serial data for 3 seconds; reconnecting")
                    continue
                last_data_at = time.monotonic()
                buffer += chunk
                while b"\n" in buffer:
                    raw_line, buffer = buffer.split(b"\n", 1)
                    line = raw_line.decode("utf-8", "replace").strip()
                    if line:
                        state.push_nano_line(name, port, line)
        except OSError as exc:
            state.set_nano_error(name, str(exc))
            time.sleep(1.0)
        except Exception as exc:
            state.set_nano_error(name, str(exc))
            time.sleep(1.0)
        finally:
            if device is not None:
                try:
                    device.close()
                except (OSError, serial.SerialException):
                    pass


def make_handler(state, udp_host, udp_port):
    class CalibrationHandler(BaseHTTPRequestHandler):
        def do_OPTIONS(self):
            self._send_json(200, {"ok": True})

        def do_GET(self):
            parsed_url = urlparse(self.path)
            path = parsed_url.path
            if path == "/api/calibration/status":
                query = dict(
                    part.split("=", 1) if "=" in part else (part, "")
                    for part in parsed_url.query.split("&") if part
                )
                source_mode = query.get("source", "both")
                if source_mode not in {"accel", "camera", "both"}:
                    source_mode = "both"
                self._send_json(200, state.status(udp_host, udp_port, source_mode))
                return
            if path == "/api/calibration/stream":
                query = dict(
                    part.split("=", 1) if "=" in part else (part, "")
                    for part in parsed_url.query.split("&") if part
                )
                source_mode = query.get("source", "both")
                if source_mode not in {"accel", "camera", "both"}:
                    source_mode = "both"
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                version = -1
                last_sent_at = 0.0
                try:
                    while True:
                        version = state.wait_for_update(version)
                        delay = 0.02 - (time.monotonic() - last_sent_at)
                        if delay > 0:
                            time.sleep(delay)
                        payload = state.stream_snapshot(source_mode)
                        body = json.dumps(payload, separators=(",", ":"))
                        self.wfile.write(f"data: {body}\n\n".encode("utf-8"))
                        self.wfile.flush()
                        last_sent_at = time.monotonic()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            self._send_json(404, {"ok": False, "error": "unknown endpoint"})

        def do_POST(self):
            path = urlparse(self.path).path
            if path in {
                "/api/calibration/capture",
                "/api/calibration/uncalibrate",
                "/api/calibration/clear",
            }:
                length = int(self.headers.get("Content-Length", "0") or "0")
                body = self.rfile.read(length).decode("utf-8", "replace") if length else "{}"
                try:
                    payload = json.loads(body or "{}")
                except json.JSONDecodeError:
                    payload = {}
                source_mode = str(payload.get("source_mode") or "both")
                if source_mode not in {"accel", "camera", "both"}:
                    source_mode = "both"
                if path == "/api/calibration/uncalibrate":
                    self._send_json(
                        200,
                        state.uncalibrate(udp_host, udp_port, source_mode),
                    )
                    return
                if path == "/api/calibration/clear":
                    self._send_json(
                        200,
                        state.clear_calibration(udp_host, udp_port, source_mode),
                    )
                    return
                self._send_json(
                    200,
                    state.capture(
                        str(payload.get("label") or ""),
                        payload.get("targets_deg"),
                        source_mode,
                    ),
                )
                return
            self._send_json(404, {"ok": False, "error": "unknown endpoint"})

        def log_message(self, fmt, *args):
            return

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return CalibrationHandler


def main():
    parser = argparse.ArgumentParser(description="Bridge graycode UDP readings into calibration HTTP endpoints.")
    parser.add_argument("--udp-host", default="127.0.0.1")
    parser.add_argument("--udp-port", type=int, default=5010)
    parser.add_argument("--http-host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=8091)
    parser.add_argument(
        "--nano",
        action="append",
        default=[],
        metavar="NAME:PORT",
        help="Read a Nano serial stream, e.g. sensor@230400:/dev/ttyUSB0. May be repeated.",
    )
    parser.add_argument("--nano-baud", type=int, default=115200)
    parser.add_argument("--wrist-accel-weight", type=float, default=0.3)
    parser.add_argument("--wrist-camera-weight", type=float, default=0.7)
    parser.add_argument("--fusion-fresh-ms", type=int, default=500)
    parser.add_argument("--filter-ms", type=float, default=180)
    args = parser.parse_args()

    state = CalibrationState(
        wrist_accel_weight=args.wrist_accel_weight,
        wrist_camera_weight=args.wrist_camera_weight,
        fusion_fresh_ms=args.fusion_fresh_ms,
        filter_tau_ms=args.filter_ms,
    )
    udp_thread = threading.Thread(
        target=run_udp_listener,
        args=(state, args.udp_host, args.udp_port),
        daemon=True,
    )
    udp_thread.start()

    for nano_spec in args.nano:
        try:
            name, port, baud = parse_nano_spec(nano_spec, args.nano_baud)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        thread = threading.Thread(
            target=run_nano_reader,
            args=(state, name, port, baud),
            daemon=True,
        )
        thread.start()

    server = ThreadingHTTPServer(
        (args.http_host, args.http_port),
        make_handler(state, args.udp_host, args.udp_port),
    )
    print(
        f"calibration bridge: UDP {args.udp_host}:{args.udp_port} -> "
        f"HTTP http://{args.http_host}:{args.http_port}/api/calibration/status",
        flush=True,
    )
    for nano_spec in args.nano:
        name, port, baud = parse_nano_spec(nano_spec, args.nano_baud)
        print(f"calibration bridge: Nano {name}:{port} @ {baud}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
