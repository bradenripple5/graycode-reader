import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const commandArgs = process.argv.slice(2);
const visualizeWithCameraGui = commandArgs.includes("--visualize-with-camera-gui");
const viteArgs = commandArgs.filter((arg) => arg !== "--visualize-with-camera-gui");
const bridgeUrl = new URL(process.env.BCR_CALIBRATION_BRIDGE_URL || "http://127.0.0.1:8091");
const defaultNanoSpecs = [
  "single@230400:/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_A5069RR4-if00-port0",
  "dual@230400:/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0",
].join(",");
const bridgeStatusUrl = new URL("/api/calibration/status", bridgeUrl);
const bridgeClearUrl = new URL("/api/calibration/clear", bridgeUrl);
const localBridgeHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const bridgeIsLocal = localBridgeHosts.has(bridgeUrl.hostname);
let bridgeProcess = null;
let readerProcess = null;
let viteProcess = null;
let shuttingDown = false;

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

async function bridgeSupportsReloadClear() {
  try {
    const response = await fetch(bridgeClearUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_mode: "both" }),
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
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
    if (!(await bridgeSupportsReloadClear())) {
      throw new Error(
        `The running calibration bridge at ${bridgeStatusUrl.origin} is out of date. Stop it and run npm run dev again.`
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
      if (!(await bridgeSupportsReloadClear())) {
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
  const args = [
    "--cameras", process.env.BCR_CALIBRATION_CAMERAS || "0,2,4,7",
    "--width", process.env.BCR_CALIBRATION_WIDTH || "640",
    "--height", process.env.BCR_CALIBRATION_HEIGHT || "480",
    "--fps", process.env.BCR_CALIBRATION_FPS || "30",
    "--process-fps", process.env.BCR_CALIBRATION_PROCESS_FPS || "10",
    "--downscale", process.env.BCR_CALIBRATION_DOWNSCALE || "320",
    "--udp-port", process.env.BCR_READER_UDP_PORT || "5000",
    "--udp-target", process.env.BCR_CALIBRATION_UDP_TARGET || "127.0.0.1:5010",
    "--ring-fit",
  ];
  if (!visualizeWithCameraGui) {
    args.splice(args.indexOf("--udp-port"), 0, "--no-window");
  }
  return args;
}

function stopExistingCameraReaders() {
  if (!visualizeWithCameraGui) return;
  let output = "";
  try {
    output = execFileSync("pgrep", ["-f", "basic_fiducial_reader"], { encoding: "utf8" });
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
  if (!visualizeWithCameraGui || !existsSync("/usr/bin/wmctrl")) return;
  const windowName = "basic fiducial native reader grid";
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
  if (!visualizeWithCameraGui && await hasLiveCalibrationData()) {
    console.log("Live calibration sensor data already available.");
    return;
  }
  if (!bridgeIsLocal) {
    throw new Error("Calibration bridge has no live data; configure its sensor reader before using a remote bridge.");
  }

  const readerBinary = resolve(projectRoot, "diagnostics", "camera_reader", "basic_fiducial_reader");
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
      ? "Starting four-camera calibration reader with camera windows..."
      : "Starting four-camera calibration reader..."
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
