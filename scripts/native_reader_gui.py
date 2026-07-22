#!/usr/bin/env python3
"""Small local launcher for the native OpenCV camera readers."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk


REPO_ROOT = Path(__file__).resolve().parents[1]
NATIVE_DIR = REPO_ROOT / "native"


class NativeReaderGui:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Native Camera Reader Launcher")
        self.process: subprocess.Popen[str] | None = None
        self.reader = tk.StringVar(value="aruco")
        self.camera_list = tk.StringVar(value="0,2,5,6")
        self.width = tk.StringVar(value="640")
        self.height = tk.StringVar(value="480")
        self.capture_fps = tk.StringVar(value="30")
        self.process_fps = tk.StringVar(value="10")
        self.downscale = tk.StringVar(value="320")
        self.tile_width = tk.StringVar(value="640")
        self.display = tk.StringVar(value=os.environ.get("DISPLAY", ":1"))
        self.no_window = tk.BooleanVar(value=False)
        self.ring_fit = tk.BooleanVar(value=True)
        self.udp_target = tk.StringVar(value="")
        self.status = tk.StringVar(value="Idle")

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=12)
        outer.grid(row=0, column=0, sticky="nsew")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        outer.columnconfigure(1, weight=1)

        ttk.Label(outer, text="Reader").grid(row=0, column=0, sticky="w")
        reader_frame = ttk.Frame(outer)
        reader_frame.grid(row=0, column=1, sticky="w")
        ttk.Radiobutton(reader_frame, text="ArUco / basic fiducial", variable=self.reader, value="aruco").grid(row=0, column=0, sticky="w")
        ttk.Radiobutton(reader_frame, text="Grayscale direction", variable=self.reader, value="grayscale").grid(row=0, column=1, sticky="w", padx=(12, 0))

        fields = [
            ("Cameras", self.camera_list, "Comma-separated V4L indexes, e.g. 0,2,5,6"),
            ("Width", self.width, ""),
            ("Height", self.height, ""),
            ("Capture FPS", self.capture_fps, ""),
            ("Process FPS", self.process_fps, "0 means unlimited"),
            ("Downscale", self.downscale, ""),
            ("Tile width", self.tile_width, "ArUco grid only"),
            ("DISPLAY", self.display, "Use :1 for TigerVNC"),
            ("UDP target", self.udp_target, "ArUco only, e.g. 127.0.0.1:5001"),
        ]
        for row, (label, variable, hint) in enumerate(fields, start=1):
            ttk.Label(outer, text=label).grid(row=row, column=0, sticky="w", pady=3)
            entry = ttk.Entry(outer, textvariable=variable, width=34)
            entry.grid(row=row, column=1, sticky="ew", pady=3)
            if hint:
                ttk.Label(outer, text=hint, foreground="#555").grid(row=row, column=2, sticky="w", padx=(8, 0))

        check_row = len(fields) + 1
        ttk.Checkbutton(outer, text="No preview window", variable=self.no_window).grid(row=check_row, column=1, sticky="w")
        ttk.Checkbutton(outer, text="ArUco ring fit", variable=self.ring_fit).grid(row=check_row, column=2, sticky="w")

        button_row = check_row + 1
        buttons = ttk.Frame(outer)
        buttons.grid(row=button_row, column=0, columnspan=3, sticky="ew", pady=(12, 8))
        ttk.Button(buttons, text="Refresh Cameras", command=self.refresh_cameras).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(buttons, text="Build Native", command=self.build_native).grid(row=0, column=1, padx=(0, 8))
        self.start_button = ttk.Button(buttons, text="Start", command=self.start)
        self.start_button.grid(row=0, column=2, padx=(0, 8))
        self.stop_button = ttk.Button(buttons, text="Stop", command=self.stop, state="disabled")
        self.stop_button.grid(row=0, column=3)

        ttk.Label(outer, textvariable=self.status).grid(row=button_row + 1, column=0, columnspan=3, sticky="w")
        self.command_text = tk.Text(outer, height=4, width=90)
        self.command_text.grid(row=button_row + 2, column=0, columnspan=3, sticky="ew", pady=(8, 0))
        self.output = tk.Text(outer, height=16, width=90)
        self.output.grid(row=button_row + 3, column=0, columnspan=3, sticky="nsew", pady=(8, 0))
        outer.rowconfigure(button_row + 3, weight=1)

        self._show_command()

    def refresh_cameras(self) -> None:
        try:
            result = subprocess.run(
                ["v4l2-ctl", "--list-devices"],
                text=True,
                capture_output=True,
                check=False,
            )
            output = result.stdout.strip() or result.stderr.strip() or "No v4l2-ctl output."
            self._append_output(output + "\n")
        except FileNotFoundError:
            self._append_output("v4l2-ctl is not installed.\n")

    def build_native(self) -> None:
        self._append_output("Building native readers...\n")
        threading.Thread(target=self._run_build, daemon=True).start()

    def _run_build(self) -> None:
        result = subprocess.run(["make", "-B"], cwd=NATIVE_DIR, text=True, capture_output=True, check=False)
        self.root.after(0, lambda: self._append_output(result.stdout + result.stderr))
        self.root.after(0, lambda: self.status.set("Build finished" if result.returncode == 0 else f"Build failed: {result.returncode}"))

    def build_command(self) -> list[str]:
        reader = self.reader.get()
        cameras = self.camera_list.get().strip()
        common = [
            "--width", self.width.get().strip(),
            "--height", self.height.get().strip(),
            "--fps", self.capture_fps.get().strip(),
            "--process-fps", self.process_fps.get().strip(),
            "--downscale", self.downscale.get().strip(),
        ]
        if self.no_window.get():
            common.append("--no-window")
        if reader == "aruco":
            cmd = [str(NATIVE_DIR / "basic_fiducial_reader")]
            if cameras:
                cmd.extend(["--cameras", cameras])
            if self.ring_fit.get():
                cmd.append("--ring-fit")
            tile_width = self.tile_width.get().strip()
            if tile_width:
                cmd.extend(["--tile-width", tile_width])
            udp_target = self.udp_target.get().strip()
            if udp_target:
                cmd.extend(["--udp-target", udp_target])
            return cmd + common

        if "," in cameras:
            raise ValueError("Grayscale reader accepts one camera per GUI process. Use a single camera index.")
        cmd = [str(NATIVE_DIR / "grayscale_direction_reader")]
        if cameras:
            cmd.extend(["--camera", cameras])
        return cmd + common

    def start(self) -> None:
        if self.process and self.process.poll() is None:
            return
        try:
            cmd = self.build_command()
        except ValueError as exc:
            messagebox.showerror("Invalid command", str(exc))
            return

        env = os.environ.copy()
        display = self.display.get().strip()
        if display:
            env["DISPLAY"] = display

        self._show_command(cmd)
        self._append_output("Starting reader...\n")
        try:
            self.process = subprocess.Popen(
                cmd,
                cwd=NATIVE_DIR,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                bufsize=1,
            )
        except FileNotFoundError as exc:
            messagebox.showerror("Start failed", str(exc))
            return

        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.status.set(f"Running pid {self.process.pid}")
        threading.Thread(target=self._read_process_output, daemon=True).start()

    def stop(self) -> None:
        if not self.process or self.process.poll() is not None:
            self._set_stopped()
            return
        self._append_output("Stopping reader...\n")
        try:
            os.killpg(self.process.pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        self.root.after(2500, self._kill_if_running)

    def _kill_if_running(self) -> None:
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)

    def _read_process_output(self) -> None:
        assert self.process is not None
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.root.after(0, self._append_output, line)
        return_code = self.process.wait()
        self.root.after(0, self._set_stopped, return_code)

    def _set_stopped(self, return_code: int | None = None) -> None:
        self.start_button.configure(state="normal")
        self.stop_button.configure(state="disabled")
        if return_code is None:
            self.status.set("Stopped")
        else:
            self.status.set(f"Stopped with exit code {return_code}")

    def _show_command(self, cmd: list[str] | None = None) -> None:
        try:
            cmd = cmd or self.build_command()
            text = " ".join(cmd)
        except ValueError as exc:
            text = str(exc)
        self.command_text.delete("1.0", "end")
        self.command_text.insert("end", text)

    def _append_output(self, text: str) -> None:
        self.output.insert("end", text)
        self.output.see("end")

    def close(self) -> None:
        self.stop()
        self.root.after(300, self.root.destroy)


def main() -> None:
    root = tk.Tk()
    root.minsize(900, 560)
    NativeReaderGui(root)
    root.mainloop()


if __name__ == "__main__":
    main()
