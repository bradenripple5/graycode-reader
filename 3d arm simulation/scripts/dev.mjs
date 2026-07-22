import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const commandArgs = process.argv.slice(2);
const helpRequested = commandArgs.includes("--help") || commandArgs.includes("-h");
const visualizeWithCameraGui = commandArgs.includes("--visualize-with-camera-gui");
const maximizeCameraGui = commandArgs.includes("--maximize-camera-gui");
const arucoCalibrationMode = commandArgs.includes("--aruco-calibration");
const launcherArgs = new Set(["--help", "-h", "--visualize-with-camera-gui", "--maximize-camera-gui", "--aruco-calibration"]);
const launcherValueArgs = [
  "--status-poll-ms",
  "--accel-polynomial-window",
  "--accel-polynomial-degree",
  "--aruco-marker-length",
  "--aruco-camera-calibration",
];

function launcherOptionValue(optionName) {
  const optionIndex = commandArgs.findIndex((arg) => (
    arg === optionName || arg.startsWith(`${optionName}=`)
  ));
  if (optionIndex < 0) return null;
  const option = commandArgs[optionIndex];
  return option.includes("=")
    ? option.slice(option.indexOf("=") + 1)
    : commandArgs[optionIndex + 1];
}

const statusPollIntervalMs = Number(
  launcherOptionValue("--status-poll-ms") ?? process.env.VITE_STATUS_POLL_INTERVAL_MS ?? 3000
);
if (!Number.isInteger(statusPollIntervalMs) || statusPollIntervalMs <= 0) {
  console.error("--status-poll-ms must be a positive whole number of milliseconds.");
  process.exit(1);
}
const accelPolynomialWindow = Number(
  launcherOptionValue("--accel-polynomial-window")
    ?? process.env.BCR_ACCEL_POLYNOMIAL_WINDOW
    ?? 10
);
if (!Number.isInteger(accelPolynomialWindow) || accelPolynomialWindow < 5) {
  console.error("--accel-polynomial-window must be a whole number of at least 5 readings.");
  process.exit(1);
}
const accelPolynomialDegree = Number(
  launcherOptionValue("--accel-polynomial-degree")
    ?? process.env.BCR_ACCEL_POLYNOMIAL_DEGREE
    ?? 1
);
if (
  !Number.isInteger(accelPolynomialDegree)
  || accelPolynomialDegree < 0
  || accelPolynomialDegree >= accelPolynomialWindow
) {
  console.error("--accel-polynomial-degree must be a non-negative whole number below the window size.");
  process.exit(1);
}
process.env.VITE_STATUS_POLL_INTERVAL_MS = String(statusPollIntervalMs);
const viteArgs = commandArgs.filter((arg, index) => {
  if (launcherArgs.has(arg)) return false;
  return !launcherValueArgs.some((optionName) => {
    if (arg === optionName || arg.startsWith(`${optionName}=`)) return true;
    return index > 0 && commandArgs[index - 1] === optionName;
  });
});
const bridgeUrl = new URL(process.env.BCR_CALIBRATION_BRIDGE_URL || "http://127.0.0.1:8091");
const defaultNanoSpecs = [
  "single@230400:/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A5069RR4-if00-port0",
  "dual@230400:/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0",
].join(",");
const bridgeStatusUrl = new URL("/api/calibration/status", bridgeUrl);
const localBridgeHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const bridgeIsLocal = localBridgeHosts.has(bridgeUrl.hostname);
const defaultCalibrationCameras = detectUsbCameraIndices() || "0";
const calibrationCameras = process.env.BCR_CALIBRATION_CAMERAS || defaultCalibrationCameras;
let bridgeProcess = null;
let readerProcess = null;
let viteProcess = null;
let shuttingDown = false;

function printCameraStartupHelp(showUsage = false) {
  const nativePreviewStatus = visualizeWithCameraGui ? "ON" : "OFF (headless)";
  const usage = showUsage ? `
Usage: npm run dev -- [launcher options] [Vite options]

Launcher options:
  --visualize-with-camera-gui  Show camera 0 in a native OpenCV window.
  --maximize-camera-gui        Maximize the camera 0 window (windowed by default).
  --aruco-calibration          Run the standard ArUco ID 0-3 pose reader instead of the ring reader.
  --aruco-marker-length M      Printed ArUco side length in meters (default: 0.04).
  --aruco-camera-calibration F OpenCV camera-intrinsics YAML file.
  --status-poll-ms <ms>        Backend status interval (default: 3000).
  --accel-polynomial-window N  Accelerometer estimator readings (default: 10, minimum: 5).
  --accel-polynomial-degree N  Accelerometer polynomial degree (default: 1).
  -h, --help                   Print this help and exit without starting services.
` : "";

  console.log(`${usage}
Camera startup modes:
  Fiducial processing: ON when this launcher starts the camera reader, whether or not a view is visible.
  Browser camera feed: REMOVED (no MJPEG encoding or video server)
  Native camera 0 window: ${nativePreviewStatus}
  Native camera window mode: ${maximizeCameraGui ? "maximized" : "windowed"}
  Backend status polling: ${statusPollIntervalMs} ms
  Accelerometer estimator: degree ${accelPolynomialDegree}, ${accelPolynomialWindow} readings
  Camera reader mode:       ${arucoCalibrationMode ? "ArUco pose IDs 0-3" : "base angle ring"}
  Detected capture nodes: ${calibrationCameras}
  Camera joint mapping:  camera 0=base

  Default headless mode:       npm run dev -- --host 0.0.0.0 --port 5176
  Show camera 0 window:        npm run dev -- --visualize-with-camera-gui --host 0.0.0.0 --port 5176
`);
}

function detectUsbCameraIndices() {
  const byPathDir = "/dev/v4l/by-path";
  try {
    const byPathIndices = readdirSync(byPathDir)
      .filter((name) => name.includes("usb") && name.endsWith("video-index0"))
      .map((name) => {
        const target = readlinkSync(resolve(byPathDir, name));
        return /video(\d+)$/.exec(target)?.[1] || "";
      })
      .filter(Boolean);
    if (byPathIndices.length) return byPathIndices.join(",");
  } catch (_error) {}

  try {
    return readdirSync("/sys/class/video4linux")
      .filter((name) => /^video\d+$/.test(name))
      .filter((name) => readFileSync(resolve("/sys/class/video4linux", name, "index"), "utf8").trim() === "0")
      .filter((name) => realpathSync(resolve("/sys/class/video4linux", name, "device")).includes("/usb"))
      .map((name) => Number(name.slice(5)))
      .sort((left, right) => left - right)
      .join(",");
  } catch (_error) {}
  return "";
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function bridgeIsHealthy() {
  const timeout = AbortSignal.timeout(1000);
  try {
    const response = await fetch(bridgeStatusUrl, { signal: timeout });
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function bridgeSupportsSensorSettings() {
  try {
    const response = await fetch(bridgeStatusUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.estimate_window_size === 5
      && payload.fusion_weighting === "sample_rate"
      && payload.accel_polynomial_window === accelPolynomialWindow
      && payload.accel_polynomial_degree === accelPolynomialDegree
      && payload.aruco && typeof payload.aruco.sample_count === "number";
  } catch (_error) {
    return false;
  }
}

async function hasLiveCalibrationData() {
  try {
    const response = await fetch(bridgeStatusUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const payload = await response.json();
    return ["base", "shoulder", "elbow", "wrist"].every((joint) => (
      Number.isFinite(Number(payload.latest?.[joint]?.angle))
    ));
  } catch (_error) {
    return false;
  }
}

function bridgeArgs() {
  const args = [
    "--udp-host", process.env.BCR_CALIBRATION_UDP_HOST || "127.0.0.1",
    "--udp-port", process.env.BCR_CALIBRATION_UDP_PORT || "5010",
    "--http-host", bridgeUrl.hostname,
    "--http-port", bridgeUrl.port || "8091",
    "--accel-polynomial-window", String(accelPolynomialWindow),
    "--accel-polynomial-degree", String(accelPolynomialDegree),
  ];
  const nanoSpecs = (process.env.BCR_CALIBRATION_NANO_SPECS
    || process.env.NANO_SPECS
    || defaultNanoSpecs)
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
  nanoSpecs.forEach((spec) => args.push("--nano", spec));
  return args;
}

async function ensureCalibrationBridge() {
  if (await bridgeIsHealthy()) {
    if (!(await bridgeSupportsSensorSettings())) {
      throw new Error(
        `The running calibration bridge at ${bridgeStatusUrl.origin} does not match the required sensor-estimation settings. Stop it and run npm run dev again.`
      );
    }
    console.log(`Calibration bridge ready at ${bridgeStatusUrl.origin}.`);
    return;
  }
  if (!bridgeIsLocal) {
    throw new Error(`Calibration bridge is unavailable at ${bridgeStatusUrl.origin}; remote bridges are not started locally.`);
  }

  const bridgeScript = resolve(projectRoot, "native", "calibration_bridge.py");
  if (!existsSync(bridgeScript)) {
    throw new Error(`Calibration bridge script not found: ${bridgeScript}`);
  }

  const python = process.env.BCR_CALIBRATION_PYTHON || "python3";
  console.log(`Starting calibration bridge at ${bridgeStatusUrl.origin}...`);
  bridgeProcess = spawn(python, [bridgeScript, ...bridgeArgs()], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  bridgeProcess.on("error", (error) => {
    console.error(`Could not start calibration bridge: ${error.message}`);
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await bridgeIsHealthy()) {
      if (!(await bridgeSupportsSensorSettings())) {
        throw new Error("Started calibration bridge does not support reload clearing.");
      }
      console.log("Calibration bridge is ready.");
      return;
    }
    if (bridgeProcess.exitCode !== null) {
      throw new Error(`Calibration bridge exited with code ${bridgeProcess.exitCode}.`);
    }
    await sleep(200);
  }
  throw new Error(`Calibration bridge did not become ready within 10 seconds at ${bridgeStatusUrl.origin}.`);
}

function readerArgs() {
  if (arucoCalibrationMode) {
    const cameraIndex = String(calibrationCameras).split(",")[0] || "0";
    const args = [
      "--camera", cameraIndex,
      "--width", process.env.BCR_CALIBRATION_WIDTH || "1280",
      "--height", process.env.BCR_CALIBRATION_HEIGHT || "720",
      "--fps", process.env.BCR_CALIBRATION_FPS || "30",
      "--process-fps", process.env.BCR_CALIBRATION_PROCESS_FPS || "10",
      "--marker-length", String(
        launcherOptionValue("--aruco-marker-length")
          ?? process.env.BCR_ARUCO_MARKER_LENGTH_M
          ?? "0.04"
      ),
      "--udp-target", process.env.BCR_CALIBRATION_UDP_TARGET || "127.0.0.1:5010",
    ];
    const calibrationFile = launcherOptionValue("--aruco-camera-calibration")
      ?? process.env.BCR_ARUCO_CAMERA_CALIBRATION;
    if (calibrationFile) args.push("--camera-calibration", calibrationFile);
    if (!visualizeWithCameraGui) args.push("--no-window");
    return args;
  }
  const args = [
    "--cameras", calibrationCameras,
    "--width", process.env.BCR_CALIBRATION_WIDTH || "640",
    "--height", process.env.BCR_CALIBRATION_HEIGHT || "480",
    "--fps", process.env.BCR_CALIBRATION_FPS || "30",
    "--process-fps", process.env.BCR_CALIBRATION_PROCESS_FPS || "10",
    "--downscale", process.env.BCR_CALIBRATION_DOWNSCALE || "320",
    "--ring-positions", process.env.BCR_CALIBRATION_RING_POSITIONS || "19",
    "--udp-port", process.env.BCR_READER_UDP_PORT || "5000",
    "--udp-target", process.env.BCR_CALIBRATION_UDP_TARGET || "127.0.0.1:5010",
  ];
  if (!visualizeWithCameraGui) {
    args.splice(args.indexOf("--udp-port"), 0, "--no-window");
  }
  return args;
}

function stopExistingCameraReaders() {
  let output = "";
  try {
    output = execFileSync("pgrep", ["-f", "basic_fiducial_reader|aruco_pose_reader"], { encoding: "utf8" });
  } catch (_error) {
    return;
  }
  output.split(/\s+/).filter(Boolean).forEach((pidText) => {
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (_error) {
        // A reader may have exited between pgrep and kill.
      }
    }
  });
}

function maximizeCameraGuiWindow() {
  if (!visualizeWithCameraGui || !maximizeCameraGui || !existsSync("/usr/bin/wmctrl")) return;
  const windowName = arucoCalibrationMode
    ? "ArUco arm calibration IDs 0-3"
    : "basic fiducial native reader grid";
  let attempts = 0;
  const maximize = () => {
    attempts += 1;
    const wmctrl = spawn("wmctrl", [
      "-r", windowName,
      "-b", "add,maximized_vert,maximized_horz",
    ], { stdio: "ignore" });
    wmctrl.on("error", () => {});
    wmctrl.on("exit", (code) => {
      if (code !== 0 && attempts < 20) {
        setTimeout(maximize, 250);
      }
    });
  };
  setTimeout(maximize, 500);
}

async function ensureSensorReader() {
  const liveCalibrationAvailable = await hasLiveCalibrationData();
  if (!arucoCalibrationMode && !visualizeWithCameraGui && liveCalibrationAvailable) {
    console.log("Live calibration sensor data already available.");
    return;
  }
  if (!bridgeIsLocal) {
    throw new Error("Calibration bridge has no live data; configure its sensor reader before using a remote bridge.");
  }
  const readerBinary = resolve(
    projectRoot,
    "diagnostics",
    "camera_reader",
    arucoCalibrationMode ? "aruco_pose_reader" : "basic_fiducial_reader"
  );
  if (!existsSync(readerBinary)) {
    throw new Error(`Camera reader not found: ${readerBinary}`);
  }

  stopExistingCameraReaders();
  if (visualizeWithCameraGui) {
    const guiDisplay = process.env.BCR_CAMERA_GUI_DISPLAY
      || process.env.DISPLAY
      || (existsSync("/tmp/.X11-unix/X1") ? ":1" : "");
    if (guiDisplay) {
      process.env.DISPLAY = guiDisplay;
    }
  }
  console.log(
    visualizeWithCameraGui
      ? "Starting camera 0 calibration reader with a camera window..."
      : "Starting camera 0 calibration reader..."
  );
  readerProcess = spawn(readerBinary, readerArgs(), {
    cwd: resolve(projectRoot, "diagnostics", "camera_reader"),
    stdio: "inherit",
  });
  readerProcess.on("error", (error) => {
    console.error(`Could not start camera reader: ${error.message}`);
  });
  maximizeCameraGuiWindow();

  // Do not prevent the browser from starting just because one physical input
  // has not produced an angle yet. The live-input panel explicitly shows each
  // camera and accelerometer as live or missing, which is more useful for
  // wiring and fiducial diagnostics than terminating the whole dev server.
  await sleep(1000);
  if (readerProcess.exitCode !== null) {
    throw new Error(`Camera reader exited with code ${readerProcess.exitCode}.`);
  }
  if (await hasLiveCalibrationData()) {
    console.log("All camera joint feeds are producing live readings.");
  } else {
    console.warn("Camera reader is running, but one or more feeds have no usable angle yet; inspect the Live Camera & Sensor Feeds panel.");
  }
}

function stopChild(child) {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
  }
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(viteProcess);
  stopChild(readerProcess);
  stopChild(bridgeProcess);
  process.exitCode = exitCode;
}

printCameraStartupHelp(helpRequested);

if (helpRequested) {
  process.exit(0);
}

try {
  await ensureCalibrationBridge();
  await ensureSensorReader();
} catch (error) {
  console.error(`Cannot start dev server: ${error.message}`);
  stopChild(readerProcess);
  stopChild(bridgeProcess);
  process.exitCode = 1;
  process.exit();
}

viteProcess = spawn(process.execPath, [resolve(projectRoot, "node_modules/vite/bin/vite.js"), ...viteArgs], {
  cwd: projectRoot,
  stdio: "inherit",
});
viteProcess.on("exit", (code) => shutdown(code ?? 1));
viteProcess.on("error", (error) => {
  console.error(`Could not start Vite: ${error.message}`);
  shutdown(1);
});

if (bridgeProcess) {
  bridgeProcess.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`Calibration bridge stopped unexpectedly (code ${code ?? "unknown"}); stopping Vite.`);
      shutdown(1);
    }
  });
}

if (readerProcess) {
  readerProcess.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`Camera reader stopped unexpectedly (code ${code ?? "unknown"}); stopping Vite.`);
      shutdown(1);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
