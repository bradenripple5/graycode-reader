#!/usr/bin/env python3
import argparse
import json
import os
import queue
import re
import select
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk


HERE = Path(__file__).resolve().parent
CONFIG_PATH = Path.home() / ".config" / "graycode_reader" / "udp_reader_gui.json"
DEFAULT_JOINT_BY_PORT = {
    "usb-0:1.2.1": "shoulder",
    "usb-0:1.2.2": "elbow",
    "usb-0:1.2.3": "wrist",
    "usb-0:1.2.4": "base",
}


def split_cameras(value):
    return [item.strip() for item in value.split(",") if item.strip()]


def usb_port_label_for_camera(camera):
    dev_name = f"video{camera}"
    by_path = Path("/dev/v4l/by-path")
    if not by_path.exists():
        return "port unknown"
    for link in sorted(by_path.glob("*usb*video-index0")):
        try:
            if link.resolve().name != dev_name:
                continue
        except OSError:
            continue
        name = link.name
        marker = "usb-0:"
        start = name.find(marker)
        if start < 0:
            return name
        end = name.find(":1.0", start)
        return name[start:] if end < 0 else name[start:end]
    return "port unknown"


def joint_label_for_port(port_label):
    return DEFAULT_JOINT_BY_PORT.get(port_label, "unassigned")


def start_basic_reader(args):
    cmd = [
        str(HERE / "basic_fiducial_reader"),
        "--cameras", args.cameras,
        "--width", str(args.width),
        "--height", str(args.height),
        "--fps", str(args.fps),
        "--process-fps", str(args.process_fps),
        "--downscale", str(args.downscale),
        "--no-window",
        "--udp-port", str(args.server_port),
    ]
    if args.ring_fit:
        cmd.append("--ring-fit")
    if getattr(args, "basic_algorithm", "") == "color-line":
        cmd.append("--color-line-reader")
    elif getattr(args, "basic_algorithm", "") == "color-line-radial":
        cmd.extend(["--color-line-reader", "--color-line-radial"])
    if getattr(args, "udp_target", ""):
        cmd.extend(["--udp-target", args.udp_target])
    print("starting:", " ".join(cmd), file=sys.stderr)
    return subprocess.Popen(cmd, cwd=HERE, text=True)


def run_basic_udp(args):
    process = start_basic_reader(args) if args.start_reader else None
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", args.client_port))
    sock.settimeout(args.timeout)
    sock.sendto(b"subscribe", (args.host, args.server_port))
    print(
        f"subscribed to {args.host}:{args.server_port} from local UDP port {args.client_port}",
        file=sys.stderr,
    )
    print("waiting for UDP packets...", file=sys.stderr)
    try:
        while True:
            try:
                data, _addr = sock.recvfrom(65535)
            except socket.timeout:
                print("still waiting for UDP packets...", file=sys.stderr)
                if process and process.poll() is not None:
                    raise SystemExit(f"reader exited with code {process.returncode}")
                sock.sendto(b"subscribe", (args.host, args.server_port))
                continue
            print(data.decode("utf-8", "replace").rstrip(), flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        if process and process.poll() is None:
            try:
                subprocess.run(["pkill", "-P", str(process.pid)], check=False)
                process.send_signal(signal.SIGINT)
                process.wait(timeout=2)
            except Exception:
                process.kill()


def grayscale_command(camera, args):
    cmd = [
        "stdbuf", "-oL", "-eL",
        str(HERE / "grayscale_direction_reader"),
        "--camera", str(camera),
        "--width", str(args.width),
        "--height", str(args.height),
        "--fps", str(args.fps),
        "--process-fps", str(args.process_fps),
        "--downscale", str(args.downscale),
        "--no-window",
    ]
    algorithm = getattr(args, "grayscale_algorithm", "edge-marker")
    if algorithm == "legacy-lines":
        cmd.append("--legacy-lines")
    elif algorithm == "projection":
        cmd.append("--projection-mode")
    elif algorithm == "raw-lines":
        cmd.append("--no-gray-direction")
    return cmd


def run_grayscale_bridge(args):
    line_re = re.compile(
        r"camera=(?P<camera>\d+)\s+frame=(?P<frame>\d+)\s+angle=(?P<angle>\S+).*?\tms=(?P<ms>\d+)"
    )
    processes = []
    streams = {}
    for camera in split_cameras(args.cameras):
        cmd = grayscale_command(camera, args)
        print("starting:", " ".join(cmd), file=sys.stderr)
        process = subprocess.Popen(
            cmd,
            cwd=HERE,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
        )
        processes.append(process)
        streams[process.stdout] = (camera, "stdout")
        streams[process.stderr] = (camera, "stderr")

    udp = None
    if args.udp_target:
        host, port_text = args.udp_target.rsplit(":", 1)
        udp = (socket.socket(socket.AF_INET, socket.SOCK_DGRAM), host, int(port_text))
        print(f"bridging grayscale JSON to UDP target {host}:{port_text}", file=sys.stderr)

    try:
        while processes:
            readable, _w, _x = select.select(list(streams), [], [], args.timeout)
            if not readable:
                print("still waiting for grayscale reader output...", file=sys.stderr)
                processes = [p for p in processes if p.poll() is None]
                continue
            for stream in readable:
                line = stream.readline()
                if not line:
                    streams.pop(stream, None)
                    continue
                camera, kind = streams[stream]
                if kind == "stderr":
                    print(f"cam{camera} stderr: {line.rstrip()}", file=sys.stderr)
                    continue
                match = line_re.search(line)
                if not match:
                    continue
                angle_text = match.group("angle")
                payload = {
                    "source": "grayscale_direction_reader_stdout_bridge",
                    "camera": int(match.group("camera")),
                    "port_label": usb_port_label_for_camera(match.group("camera")),
                    "frame": int(match.group("frame")),
                    "angle": None if angle_text == "n/a" else float(angle_text),
                    "elapsed_ms": int(match.group("ms")),
                }
                text = json.dumps(payload, sort_keys=True)
                print(text, flush=True)
                if udp:
                    sock, host, port = udp
                    sock.sendto((text + "\n").encode("utf-8"), (host, port))
            processes = [p for p in processes if p.poll() is None]
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                try:
                    process.send_signal(signal.SIGINT)
                    process.wait(timeout=2)
                except Exception:
                    process.kill()


class UdpReaderGui:
    def __init__(self, root):
        self.root = root
        self.root.title("UDP Camera Reader")
        self.processes = []
        self.listener_socket = None
        self.stop_event = threading.Event()
        self.output_queue = queue.Queue()

        self.reader_mode = tk.StringVar(value="grayscale")
        self.basic_algorithm = tk.StringVar(value="ring-fit")
        self.grayscale_algorithm = tk.StringVar(value="edge-marker")
        self.camera_count = tk.IntVar(value=4)
        self.camera_list = tk.StringVar(value="0,2,4,6")
        self.width = tk.StringVar(value="640")
        self.height = tk.StringVar(value="480")
        self.capture_fps = tk.StringVar(value="30")
        self.process_fps = tk.StringVar(value="10")
        self.downscale = tk.StringVar(value="320")
        self.server_port = tk.StringVar(value="5000")
        self.client_port = tk.StringVar(value="5001")
        self.udp_target = tk.StringVar(value="")
        self.display = tk.StringVar(value=os.environ.get("DISPLAY", ":1"))
        self.show_video = tk.BooleanVar(value=False)
        self.separate_windows = tk.BooleanVar(value=False)
        self.start_on_launch = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value="Idle")
        self.camera_vars = {}
        self.camera_checks_frame = None
        self.joint_by_port = dict(DEFAULT_JOINT_BY_PORT)
        self._loading_settings = True
        self._loaded_settings = self._load_settings()

        self._build_ui()
        self._loading_settings = False
        self._detect_cameras(update_entry=False)
        self._poll_queue()
        self.root.protocol("WM_DELETE_WINDOW", self.close)
        if self.start_on_launch.get():
            self.root.after(500, self.start)

    def _build_ui(self):
        outer = ttk.Frame(self.root, padding=12)
        outer.grid(row=0, column=0, sticky="nsew")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        outer.columnconfigure(1, weight=1)
        outer.rowconfigure(11, weight=1)

        ttk.Label(outer, text="Reader").grid(row=0, column=0, sticky="w")
        mode_frame = ttk.Frame(outer)
        mode_frame.grid(row=0, column=1, sticky="w")
        ttk.Radiobutton(mode_frame, text="Grayscale direction", variable=self.reader_mode, value="grayscale", command=self._refresh_command).grid(row=0, column=0, sticky="w")
        ttk.Radiobutton(mode_frame, text="Basic fiducial UDP", variable=self.reader_mode, value="basic", command=self._refresh_command).grid(row=0, column=1, sticky="w", padx=(16, 0))

        ttk.Label(outer, text="Grayscale algo").grid(row=1, column=0, sticky="w", pady=3)
        grayscale_combo = ttk.Combobox(
            outer,
            textvariable=self.grayscale_algorithm,
            values=("edge-marker", "legacy-lines", "projection", "raw-lines"),
            state="readonly",
        )
        grayscale_combo.grid(row=1, column=1, sticky="ew", pady=3)
        grayscale_combo.bind("<<ComboboxSelected>>", lambda _event: self._refresh_command())

        ttk.Label(outer, text="Basic algo").grid(row=2, column=0, sticky="w", pady=3)
        basic_combo = ttk.Combobox(
            outer,
            textvariable=self.basic_algorithm,
            values=("ring-fit", "simple-pairs", "color-line", "color-line-radial"),
            state="readonly",
        )
        basic_combo.grid(row=2, column=1, sticky="ew", pady=3)
        basic_combo.bind("<<ComboboxSelected>>", lambda _event: self._refresh_command())

        camera_frame = ttk.Frame(outer)
        camera_frame.grid(row=3, column=1, sticky="ew", pady=3)
        camera_frame.columnconfigure(1, weight=1)
        ttk.Label(outer, text="Cameras").grid(row=3, column=0, sticky="w")
        ttk.Spinbox(camera_frame, from_=1, to=12, textvariable=self.camera_count, width=5, command=self._apply_camera_count).grid(row=0, column=0, sticky="w")
        ttk.Entry(camera_frame, textvariable=self.camera_list).grid(row=0, column=1, sticky="ew", padx=(8, 8))
        ttk.Button(camera_frame, text="Detect", command=lambda: self._detect_cameras(update_entry=True)).grid(row=0, column=2)
        ttk.Button(camera_frame, text="All", command=self._select_all_cameras).grid(row=0, column=3, padx=(8, 0))
        ttk.Button(camera_frame, text="None", command=self._select_no_cameras).grid(row=0, column=4, padx=(4, 0))

        self.camera_checks_frame = ttk.Frame(outer)
        self.camera_checks_frame.grid(row=4, column=1, sticky="ew", pady=(0, 6))

        fields = [
            ("Width", self.width),
            ("Height", self.height),
            ("Capture FPS", self.capture_fps),
            ("Process FPS", self.process_fps),
            ("Downscale", self.downscale),
            ("UDP server port", self.server_port),
            ("UDP client port", self.client_port),
            ("Forward UDP target", self.udp_target),
            ("DISPLAY", self.display),
        ]
        for index, (label, variable) in enumerate(fields, start=5):
            ttk.Label(outer, text=label).grid(row=index, column=0, sticky="w", pady=3)
            entry = ttk.Entry(outer, textvariable=variable)
            entry.grid(row=index, column=1, sticky="ew", pady=3)
            entry.bind("<KeyRelease>", lambda _event: self._refresh_command())

        preview_frame = ttk.Frame(outer)
        preview_frame.grid(row=14, column=0, columnspan=2, sticky="w", pady=(8, 0))
        ttk.Checkbutton(preview_frame, text="Show video preview", variable=self.show_video, command=self._refresh_command).grid(row=0, column=0, sticky="w")
        ttk.Checkbutton(preview_frame, text="Separate preview windows", variable=self.separate_windows, command=self._refresh_command).grid(row=0, column=1, sticky="w", padx=(16, 0))
        ttk.Checkbutton(preview_frame, text="Start on launch", variable=self.start_on_launch, command=self._save_settings).grid(row=0, column=2, sticky="w", padx=(16, 0))

        buttons = ttk.Frame(outer)
        buttons.grid(row=15, column=0, columnspan=2, sticky="ew", pady=(10, 6))
        self.start_button = ttk.Button(buttons, text="Start", command=self.start)
        self.start_button.grid(row=0, column=0, padx=(0, 8))
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.grid(row=0, column=1, padx=(0, 8))
        ttk.Button(buttons, text="Clear Output", command=self.clear_output).grid(row=0, column=2)
        ttk.Label(buttons, textvariable=self.status).grid(row=0, column=3, sticky="w", padx=(12, 0))

        ttk.Label(outer, text="Command").grid(row=16, column=0, sticky="nw")
        self.command_box = tk.Text(outer, height=3, wrap="word")
        self.command_box.grid(row=16, column=1, sticky="ew", pady=(0, 6))

        ttk.Label(outer, text="UDP / reader output").grid(row=17, column=0, sticky="nw")
        self.output_box = tk.Text(outer, height=18, wrap="none")
        self.output_box.grid(row=17, column=1, sticky="nsew")
        outer.rowconfigure(17, weight=1)

        for variable in (
            self.camera_count,
            self.camera_list,
            self.width,
            self.height,
            self.capture_fps,
            self.process_fps,
            self.downscale,
            self.server_port,
            self.client_port,
            self.udp_target,
            self.display,
        ):
            variable.trace_add("write", lambda *_args: self._settings_changed())
        for variable in (
            self.reader_mode,
            self.basic_algorithm,
            self.grayscale_algorithm,
            self.show_video,
            self.separate_windows,
            self.start_on_launch,
        ):
            variable.trace_add("write", lambda *_args: self._settings_changed())
        self._refresh_command()

    def _settings(self):
        return {
            "reader_mode": self.reader_mode.get(),
            "basic_algorithm": self.basic_algorithm.get(),
            "grayscale_algorithm": self.grayscale_algorithm.get(),
            "camera_count": self.camera_count.get(),
            "camera_list": self.camera_list.get(),
            "width": self.width.get(),
            "height": self.height.get(),
            "capture_fps": self.capture_fps.get(),
            "process_fps": self.process_fps.get(),
            "downscale": self.downscale.get(),
            "server_port": self.server_port.get(),
            "client_port": self.client_port.get(),
            "udp_target": self.udp_target.get(),
            "display": self.display.get(),
            "show_video": self.show_video.get(),
            "separate_windows": self.separate_windows.get(),
            "start_on_launch": self.start_on_launch.get(),
            "joint_by_port": self.joint_by_port,
        }

    def _load_settings(self):
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as file:
                settings = json.load(file)
        except FileNotFoundError:
            return False
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Could not load {CONFIG_PATH}: {exc}", file=sys.stderr)
            return False

        string_vars = {
            "reader_mode": self.reader_mode,
            "basic_algorithm": self.basic_algorithm,
            "grayscale_algorithm": self.grayscale_algorithm,
            "camera_list": self.camera_list,
            "width": self.width,
            "height": self.height,
            "capture_fps": self.capture_fps,
            "process_fps": self.process_fps,
            "downscale": self.downscale,
            "server_port": self.server_port,
            "client_port": self.client_port,
            "udp_target": self.udp_target,
            "display": self.display,
        }
        for key, variable in string_vars.items():
            if key in settings:
                variable.set(str(settings[key]))
        if "camera_count" in settings:
            try:
                self.camera_count.set(max(1, int(settings["camera_count"])))
            except (TypeError, ValueError):
                pass
        for key, variable in {
            "show_video": self.show_video,
            "separate_windows": self.separate_windows,
            "start_on_launch": self.start_on_launch,
        }.items():
            if key in settings:
                variable.set(bool(settings[key]))
        if isinstance(settings.get("joint_by_port"), dict):
            self.joint_by_port.update({str(key): str(value) for key, value in settings["joint_by_port"].items()})
        return True

    def _save_settings(self):
        if self._loading_settings:
            return
        try:
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with CONFIG_PATH.open("w", encoding="utf-8") as file:
                json.dump(self._settings(), file, indent=2, sort_keys=True)
                file.write("\n")
        except OSError as exc:
            print(f"Could not save {CONFIG_PATH}: {exc}", file=sys.stderr)

    def _settings_changed(self):
        self._refresh_command()
        self._save_settings()

    def _args(self):
        args = argparse.Namespace()
        args.cameras = self.camera_list.get().strip()
        if not args.cameras:
            raise ValueError("Select at least one camera.")
        args.width = int(self.width.get().strip())
        args.height = int(self.height.get().strip())
        args.fps = float(self.capture_fps.get().strip())
        args.process_fps = float(self.process_fps.get().strip())
        args.downscale = int(self.downscale.get().strip())
        args.server_port = int(self.server_port.get().strip())
        args.client_port = int(self.client_port.get().strip())
        args.host = "127.0.0.1"
        args.timeout = 1.0
        args.ring_fit = self.basic_algorithm.get() == "ring-fit"
        args.basic_algorithm = self.basic_algorithm.get()
        args.grayscale_algorithm = self.grayscale_algorithm.get()
        args.udp_target = self.udp_target.get().strip()
        args.display = self.display.get().strip()
        return args

    def _build_reader_commands(self):
        args = self._args()
        if self.reader_mode.get() == "basic":
            cmd = [
                str(HERE / "basic_fiducial_reader"),
                "--cameras", args.cameras,
                "--width", str(args.width),
                "--height", str(args.height),
                "--fps", str(args.fps),
                "--process-fps", str(args.process_fps),
                "--downscale", str(args.downscale),
                "--udp-port", str(args.server_port),
            ]
            if not self.show_video.get():
                cmd.append("--no-window")
            elif self.separate_windows.get():
                cmd.append("--separate-windows")
            if args.ring_fit:
                cmd.append("--ring-fit")
            if args.basic_algorithm == "color-line":
                cmd.append("--color-line-reader")
            elif args.basic_algorithm == "color-line-radial":
                cmd.extend(["--color-line-reader", "--color-line-radial"])
            if args.udp_target:
                cmd.extend(["--udp-target", args.udp_target])
            return [cmd]

        commands = []
        for camera in split_cameras(args.cameras):
            cmd = grayscale_command(camera, args)
            if self.show_video.get() and "--no-window" in cmd:
                cmd.remove("--no-window")
            commands.append(cmd)
        return commands

    def _refresh_command(self):
        try:
            commands = self._build_reader_commands()
            lines = [" ".join(cmd) for cmd in commands]
            if self.reader_mode.get() == "basic":
                lines.append(f"UDP subscribe: 127.0.0.1:{self.server_port.get()} -> local port {self.client_port.get()}")
            elif self.udp_target.get().strip():
                lines.append(f"Bridge JSON to UDP target {self.udp_target.get().strip()}")
            if self.show_video.get() and self.display.get().strip():
                lines.append(f"Video preview DISPLAY={self.display.get().strip()}")
            text = "\n".join(lines)
        except Exception as exc:
            text = f"Invalid settings: {exc}"
        self.command_box.delete("1.0", "end")
        self.command_box.insert("end", text)

    def _apply_camera_count(self):
        detected = list(self.camera_vars) or self._camera_indices()
        if not detected:
            detected = [str(index * 2) for index in range(max(1, self.camera_count.get()))]
        count = max(1, self.camera_count.get())
        selected = set(detected[:count])
        self._set_camera_checks(detected, selected)
        self._save_settings()

    def _camera_indices_from_v4l2(self):
        by_path = Path("/dev/v4l/by-path")
        if by_path.exists():
            cameras = []
            for link in sorted(by_path.glob("*usb*video-index0")):
                try:
                    target = link.resolve()
                except OSError:
                    continue
                name = target.name
                if name.startswith("video") and name[5:].isdigit():
                    cameras.append(name[5:])
            if cameras:
                return cameras

        try:
            result = subprocess.run(
                ["v4l2-ctl", "--list-devices"],
                text=True,
                capture_output=True,
                check=False,
            )
        except FileNotFoundError:
            return []

        if result.returncode != 0:
            return []

        cameras = []
        current = []
        current_is_usb_camera = False
        for line in result.stdout.splitlines():
            stripped = line.strip()
            if not stripped:
                if current and current_is_usb_camera:
                    cameras.append(current[0])
                current = []
                current_is_usb_camera = False
                continue
            if not line.startswith((" ", "\t")):
                lower = stripped.lower()
                current_is_usb_camera = (
                    "usb-" in lower
                    and "camera" in lower
                    and "bcm" not in lower
                    and "codec" not in lower
                    and "isp" not in lower
                )
            if stripped.startswith("/dev/video"):
                suffix = stripped.rsplit("video", 1)[-1]
                if suffix.isdigit():
                    current.append(suffix)
        if current and current_is_usb_camera:
            cameras.append(current[0])
        return cameras

    def _camera_indices_from_dev(self):
        devs = sorted(
            Path("/dev").glob("video*"),
            key=lambda path: int(path.name.replace("video", "")) if path.name.replace("video", "").isdigit() else 9999,
        )
        indices = []
        for dev in devs:
            suffix = dev.name.replace("video", "")
            if suffix.isdigit():
                indices.append(suffix)
        if len(indices) > 1:
            even_indices = [index for index in indices if int(index) % 2 == 0]
            if even_indices:
                return even_indices
        return indices

    def _camera_indices(self):
        return self._camera_indices_from_v4l2() or self._camera_indices_from_dev()

    def _detect_cameras(self, update_entry):
        indices = self._camera_indices()
        if update_entry and indices:
            count = min(len(indices), max(1, self.camera_count.get()))
            self.camera_count.set(count)
            selected = set(indices[:count])
            self._set_camera_checks(indices, selected)
        elif indices:
            existing = set(split_cameras(self.camera_list.get()))
            selected = existing.intersection(indices)
            if not selected:
                selected = set(indices[: min(len(indices), self.camera_count.get())])
            self._set_camera_checks(indices, selected)
        if indices:
            self._append_output("Detected cameras: " + ",".join(indices) + "\n")
        else:
            fallback = split_cameras(self.camera_list.get())
            self._set_camera_checks(fallback, set(fallback))
            self._append_output("No /dev/video* cameras detected.\n")

    def _set_camera_checks(self, indices, selected):
        if self.camera_checks_frame is None:
            return
        for child in self.camera_checks_frame.winfo_children():
            child.destroy()
        self.camera_vars = {}
        for column, index in enumerate(indices):
            var = tk.BooleanVar(value=index in selected)
            self.camera_vars[index] = var
            port_label = usb_port_label_for_camera(index)
            joint_label = self.joint_by_port.get(port_label, "unassigned")
            check = ttk.Checkbutton(
                self.camera_checks_frame,
                text=f"{joint_label}: /dev/video{index} ({port_label})",
                variable=var,
                command=self._sync_checked_cameras_to_entry,
            )
            check.grid(row=0, column=column, sticky="w", padx=(0, 10), pady=2)
        self._sync_checked_cameras_to_entry()

    def _sync_checked_cameras_to_entry(self):
        if not self.camera_vars:
            return
        selected = [index for index, var in self.camera_vars.items() if var.get()]
        self.camera_count.set(max(1, len(selected)))
        self.camera_list.set(",".join(selected))
        self._refresh_command()
        self._save_settings()

    def _select_all_cameras(self):
        for var in self.camera_vars.values():
            var.set(True)
        self._sync_checked_cameras_to_entry()

    def _select_no_cameras(self):
        for var in self.camera_vars.values():
            var.set(False)
        self._sync_checked_cameras_to_entry()

    def _camera_mapping_text(self, cameras):
        lines = ["Camera mapping:"]
        for camera in split_cameras(cameras):
            port_label = usb_port_label_for_camera(camera)
            joint_label = self.joint_by_port.get(port_label, "unassigned")
            lines.append(f"  {joint_label}: {port_label} -> /dev/video{camera}")
        return "\n".join(lines) + "\n"

    def start(self):
        if self.processes:
            return
        try:
            args = self._args()
            commands = self._build_reader_commands()
        except Exception as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return

        self._save_settings()
        self.stop_event.clear()
        self.clear_output()
        self._append_output("Starting reader interface...\n")
        self._append_output(self._camera_mapping_text(args.cameras))
        env = os.environ.copy()
        if args.display:
            env["DISPLAY"] = args.display
        try:
            for cmd in commands:
                self._append_output("starting: " + " ".join(cmd) + "\n")
                process = subprocess.Popen(
                    cmd,
                    cwd=HERE,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    env=env,
                    bufsize=1,
                )
                self.processes.append(process)
                threading.Thread(target=self._read_process_output, args=(process,), daemon=True).start()
        except FileNotFoundError as exc:
            self.stop()
            messagebox.showerror("Start failed", str(exc))
            return

        if self.reader_mode.get() == "basic":
            threading.Thread(target=self._run_udp_listener, args=(args,), daemon=True).start()
        elif args.udp_target:
            threading.Thread(target=self._run_grayscale_udp_forwarder, args=(args,), daemon=True).start()

        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.status.set(f"Running {len(self.processes)} process(es)")

    def _run_udp_listener(self, args):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.listener_socket = sock
        try:
            sock.bind(("0.0.0.0", args.client_port))
            sock.settimeout(args.timeout)
            sock.sendto(b"subscribe", ("127.0.0.1", args.server_port))
            self.output_queue.put(f"subscribed to UDP 127.0.0.1:{args.server_port} from local port {args.client_port}\n")
            while not self.stop_event.is_set():
                try:
                    data, _addr = sock.recvfrom(65535)
                except socket.timeout:
                    sock.sendto(b"subscribe", ("127.0.0.1", args.server_port))
                    continue
                self.output_queue.put(data.decode("utf-8", "replace").rstrip() + "\n")
        except OSError as exc:
            self.output_queue.put(f"UDP listener error: {exc}\n")
        finally:
            sock.close()

    def _run_grayscale_udp_forwarder(self, args):
        host, port_text = args.udp_target.rsplit(":", 1)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.output_queue.put(f"grayscale JSON forwarding enabled to {host}:{port_text}\n")
        while not self.stop_event.is_set():
            time.sleep(0.2)
        sock.close()

    def _read_process_output(self, process):
        line_re = re.compile(
            r"camera=(?P<camera>\d+)\s+frame=(?P<frame>\d+)\s+angle=(?P<angle>\S+).*?\tms=(?P<ms>\d+)"
        )
        udp_target = self.udp_target.get().strip()
        udp_sock = None
        udp_host = ""
        udp_port = 0
        if self.reader_mode.get() == "grayscale" and udp_target:
            udp_host, port_text = udp_target.rsplit(":", 1)
            udp_port = int(port_text)
            udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        assert process.stdout is not None
        for line in process.stdout:
            if self.stop_event.is_set():
                break
            text = line
            if self.reader_mode.get() == "grayscale":
                match = line_re.search(line)
                if match:
                    angle_text = match.group("angle")
                    payload = {
                        "source": "grayscale_direction_reader_stdout_bridge",
                        "camera": int(match.group("camera")),
                        "port_label": usb_port_label_for_camera(match.group("camera")),
                        "frame": int(match.group("frame")),
                        "angle": None if angle_text == "n/a" else float(angle_text),
                        "elapsed_ms": int(match.group("ms")),
                    }
                    text = json.dumps(payload, sort_keys=True) + "\n"
                    if udp_sock:
                        udp_sock.sendto(text.encode("utf-8"), (udp_host, udp_port))
            self.output_queue.put(text)
        if udp_sock:
            udp_sock.close()
        process.wait()
        self.output_queue.put(f"process {process.pid} exited with {process.returncode}\n")
        self.root.after(0, self._check_stopped)

    def _poll_queue(self):
        try:
            while True:
                self._append_output(self.output_queue.get_nowait())
        except queue.Empty:
            pass
        self.root.after(100, self._poll_queue)

    def stop(self):
        self.stop_event.set()
        if self.listener_socket:
            try:
                self.listener_socket.close()
            except OSError:
                pass
            self.listener_socket = None
        for process in list(self.processes):
            if process.poll() is None:
                try:
                    process.send_signal(signal.SIGINT)
                except ProcessLookupError:
                    pass
        self.root.after(1500, self._kill_if_running)

    def _kill_if_running(self):
        for process in list(self.processes):
            if process.poll() is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
        self._check_stopped()

    def _check_stopped(self):
        self.processes = [process for process in self.processes if process.poll() is None]
        if not self.processes:
            self.start_button.configure(state="normal")
            self.stop_button.configure(state="disabled")
            self.status.set("Stopped")

    def clear_output(self):
        self.output_box.delete("1.0", "end")

    def _append_output(self, text):
        self.output_box.insert("end", text)
        self.output_box.see("end")

    def close(self):
        self._save_settings()
        self.stop()
        self.root.after(300, self.root.destroy)


def run_gui():
    root = tk.Tk()
    root.minsize(980, 680)
    UdpReaderGui(root)
    root.mainloop()


def main():
    parser = argparse.ArgumentParser(description="Read native reader UDP/angle output.")
    parser.add_argument("--cli", action="store_true", help="Use command-line mode instead of opening the GUI.")
    parser.add_argument("--gui", action="store_true", help="Open the local Tk interface.")
    parser.add_argument("--mode", choices=["basic", "grayscale"], default="basic")
    parser.add_argument("--start-reader", action="store_true", help="Start basic_fiducial_reader before subscribing.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--server-port", type=int, default=5000)
    parser.add_argument("--client-port", type=int, default=5001)
    parser.add_argument("--udp-target", default="", help="For grayscale bridge, also send JSON to host:port.")
    parser.add_argument("--cameras", default="0,2,5,6")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=float, default=30)
    parser.add_argument("--process-fps", type=float, default=10)
    parser.add_argument("--downscale", type=int, default=320)
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--ring-fit", action="store_true")
    parser.add_argument("--basic-algorithm", choices=["ring-fit", "simple-pairs", "color-line", "color-line-radial"], default="")
    parser.add_argument("--grayscale-algorithm", choices=["edge-marker", "legacy-lines", "projection", "raw-lines"], default="edge-marker")
    args = parser.parse_args()

    if args.gui or not args.cli:
        run_gui()
        return

    if args.mode == "grayscale":
        run_grayscale_bridge(args)
    else:
        run_basic_udp(args)


if __name__ == "__main__":
    main()
