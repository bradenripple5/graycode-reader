import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { createAssetLoader } from "./assetLoader.js";
import {
  BELT_CROSS_HALF_SPAN,
  BELT_TRUNK_BOTTOM_Y,
  BELT_TRUNK_TOP_Y,
  BOX_DIMS,
  DESTINATION_CENTERS,
  DESTINATION_PALLET_DIMS,
  FACILITY_BELT_WIDTH,
  FACILITY_BELT_Z,
  GANTRY_ARM_CONFIG,
  GANTRY_DIMS,
  LOWER_CROSS_BELT_Y,
  SOURCE_GANTRY_CENTER,
  SOURCE_OFFLOAD_Y,
  SOURCE_PALLET_DIMS,
  SOURCE_STACK_CENTER,
  getDestinationPalletSlots,
  getGantryCellSpecs,
  getSourceBoxPositions,
  getSourcePalletSlots,
  getSourcePickupCenter,
  findAttachableSourceBox,
  resetGantryArmSystems,
} from "./gantryScene.js";
import { normalizeSceneId } from "./sceneRegistry.js";

const poseButtons = document.getElementById("pose-buttons");
const jointForm = document.getElementById("joint-form");
const statusOutput = document.getElementById("status-output");
const presetDuration = document.getElementById("preset-duration");
const customDuration = document.getElementById("custom-duration");
const directDuration = document.getElementById("direct-duration");
const sendCustomButton = document.getElementById("send-custom");
const sendDirectButton = document.getElementById("send-direct");
const sequenceButtons = document.getElementById("sequence-buttons");
const copyCurrentButton = document.getElementById("copy-current");
const refreshButton = document.getElementById("refresh");
const syncRobotButton = document.getElementById("sync-robot");
const syncStatus = document.getElementById("sync-status");
const resetCameraButton = document.getElementById("reset-camera");
const autoZoomOutButton = document.getElementById("auto-zoom-out");
const toggleAccelerometerVectorsButton = document.getElementById("toggle-accelerometer-vectors");
const accelerometerVectorScaleInput = document.getElementById("accelerometer-vector-scale");
const accelerometerVectorScaleValue = document.getElementById("accelerometer-vector-scale-value");
const accelerometer3dLegend = document.getElementById("accelerometer-3d-legend");
const cycleGantryFocusButton = document.getElementById("cycle-gantry-focus");
const calibrateCurrentButton = document.getElementById("calibrate-current");
const moveCalibrationPoseButton = document.getElementById("move-calibration-pose");
const finishCalibrationButton = document.getElementById("finish-calibration");
const calibrationCoverage = document.getElementById("calibration-coverage");
const calibrationCompletionMessage = document.getElementById("calibration-completion-message");
const clearLoadedCalibrationButton = document.getElementById("clear-loaded-calibration");
const uncalibrateCurrentButton = document.getElementById("uncalibrate-current");
const calibrationSourceSelect = document.getElementById("calibration-source");
const calibrationStatus = document.getElementById("calibration-status");
const liveCameraFeeds = document.getElementById("live-camera-feeds");
const liveAccelerometerFeeds = document.getElementById("live-accelerometer-feeds");
const calibrationRows = document.getElementById("calibration-rows");
const calibrationTargetInputs = {
  base: document.getElementById("calibration-target-base"),
  shoulder: document.getElementById("calibration-target-shoulder"),
  elbow: document.getElementById("calibration-target-elbow"),
  wrist: document.getElementById("calibration-target-wrist"),
};
const clearCommandsButton = document.getElementById("clear-commands");
const commandLog = document.getElementById("command-log");
const sceneSelect = document.getElementById("scene-select");
const sceneItemSelect = document.getElementById("scene-item");
const placeItemButton = document.getElementById("place-item");
const removeItemButton = document.getElementById("remove-item");
const itemStatus = document.getElementById("item-status");
const importModelFileInput = document.getElementById("import-model-file");
const importModelButton = document.getElementById("import-model-button");
const importedModelSelect = document.getElementById("imported-model-select");
const removeImportedModelButton = document.getElementById("remove-imported-model-button");
const importedModelStatus = document.getElementById("imported-model-status");
const directCommandInput = document.getElementById("direct-command");
const viewerCanvas = document.getElementById("viewer");
const viewerPanel = viewerCanvas.parentElement;

const DEFAULT_ARM_POSE = [0.0, -1.57, 0.0, 0.0, 0.0, 4.71, 0.0];
let lastStatus = null;
let commandHistory = [];
let importedModelCounter = 0;
let importedModels = [];
let backendConnected = false;
let localJointPositions = [...DEFAULT_ARM_POSE];
let targetJointPositions = [...DEFAULT_ARM_POSE];
let activeMotion = null;
let backendSmoothedPositions = [...DEFAULT_ARM_POSE];
let backendBlend = null;
let sensorBlend = null;
let backendSmoothingInitialized = false;
let udpCalibrationSyncPinned = false;
let collisionState = {
  active: false,
  messages: [],
};
const JOINT_STATE_FRESHNESS_SEC = 2.5;
const configuredStatusPollIntervalMs = Number(import.meta.env.VITE_STATUS_POLL_INTERVAL_MS);
const STATUS_POLL_INTERVAL_MS = Number.isInteger(configuredStatusPollIntervalMs)
  && configuredStatusPollIntervalMs > 0
  ? configuredStatusPollIntervalMs
  : 3000;
const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const DEMO_NO_BACKEND = String(import.meta.env.VITE_DEMO_NO_BACKEND || "").toLowerCase() === "true";
const CALIBRATION_JOINTS = ["base", "shoulder", "elbow", "wrist"];
const CALIBRATION_ROW_SELECTION_STORAGE_KEY = "bcr.loaded-calibration-row-ids.v1";
const DEFAULT_CAMERA_FEEDS = [0];
const AUTO_CALIBRATION_SETTLE_MS = 350;
const UDP_ARM_CHANGE_EPSILON_DEG = 0.2;
const UDP_TO_ARM_JOINTS = {
  base: { index: 0, sign: 1 },
  shoulder: { index: 1, sign: -1 },
  elbow: { index: 3, sign: 1 },
  wrist: { index: 5, sign: -1 },
};
const DEFAULT_CALIBRATION_TARGETS_DEG = {
  base: 0,
  shoulder: 0,
  elbow: 0,
  wrist: 0,
};
const ACCELEROMETER_3D_CONFIG = {
  "dual:0x68": { joint: "shoulder", jointIndex: 1, position: [0, 0.11, 0.035], rotation: [0, 0, 0] },
  "dual:0x69": { joint: "elbow", jointIndex: 3, position: [0, 0.11, 0.035], rotation: [0, 0, 0] },
  "single:0x68": { joint: "wrist", jointIndex: 5, position: [0, 0.11, 0.035], rotation: [0, 0, 0] },
};
const ACCELEROMETER_VECTOR_COLORS = {
  x: 0xff4d4d,
  y: 0x55dd77,
  z: 0x4da3ff,
  resultant: 0xffe45c,
};
let lastAppliedUdpAngles = null;
let calibratedUdpReferenceAngles = null;
let calibratedTargetAngles = { ...DEFAULT_CALIBRATION_TARGETS_DEG };
let calibratedReferenceId = null;
let calibratedSensorModels = null;
let calibrationEventSource = null;
const calibrationSnapshots = new Map();
const baseCameraDisplayHistory = {
  lastFrame: null,
  samples: [],
};
let availableCalibrationRowsCache = [];
let calibrationRowsCache = [];
let loadedCalibrationRowIds = loadCalibrationRowSelection();
let preCalibrationActive = true;
let sensorControlLocked = false;
let calibrationCompletionSummary = "";
let automaticCalibrationCaptureTimer = null;
let automaticCalibrationCaptureId = 0;
let automaticCalibrationCaptureInFlight = false;
let pendingAutomaticCalibrationCapture = null;
let accelerometerVisualsVisible = true;
let accelerometerVectorScale = 1;
const accelerometerVisuals = new Map();
const accelerometerReadings = new Map();

const ARM_CONFIG = {
  chain: [
    { offset: [0, 0, 0.025], axis: "z", drawTo: [0, 0, 0.2], radius: 0.04, color: 0xd6ff57 },
    { offset: [0, 0, 0.2], axis: "x", drawTo: [0.065, 0, 0], radius: 0.034, color: 0x7cd1ff },
    { offset: [0.065, 0, 0], axis: "z", drawTo: [0, 0, 0.41], radius: 0.032, color: 0xd6ff57 },
    { offset: [0, 0, 0.41], axis: "x", drawTo: [-0.065, 0, 0], radius: 0.028, color: 0x7cd1ff },
    { offset: [-0.065, 0, 0], axis: "z", drawTo: [0, 0, 0.31], radius: 0.026, color: 0xd6ff57 },
    { offset: [0, 0, 0.31], axis: "x", drawTo: [0.06, 0, 0], radius: 0.022, color: 0x7cd1ff },
    { offset: [0.06, 0, 0], axis: "z", drawTo: [0, 0, 0.105], radius: 0.02, color: 0xd6ff57 },
  ],
};

const ENVIRONMENT = {
  floorZ: 0,
  tableCenter: new THREE.Vector3(0.43, 0, 0.12),
  tableSize: new THREE.Vector3(0.5, 0.64, 0.24),
};

const PREDEFINED_POSES = {
  home: [0.0, -1.57, 0.0, 3.14, 0.0, 3.14, 0.0],
  ready: [0.0, -0.785, 0.0, -1.57, 0.0, 0.785, 0.0],
  stretch_up: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  forward_low: [0.0, -1.57, 0.0, 0.0, 0.0, 0.0, 0.0],
  forward_low_wrist_down: [0.0, -1.57, 0.0, 0.0, 0.0, 4.71, 0.0],
  forward_down: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
};
let currentPredefinedPoses = { ...PREDEFINED_POSES };
let currentPresetSignature = JSON.stringify(currentPredefinedPoses);

const JOINT_NAMES = [
  "base",
  "shoulder",
  "upper twist",
  "elbow",
  "forearm twist",
  "wrist",
  "tool twist",
];

let scene;
let renderer;
let camera;
let controls;
let currentSceneId = "arm";
let armRoot;
let armSceneGroup;
let gantrySceneGroup;
let tableMesh;
let boxMesh;
let gantryBridge;
let gantryCarriage;
let gantryHook;
let gantryGripperPad;
let gantryGripperCups = [];
let gantryTravelX = 0.95;
let gantryTravelY = 0.58;
let gantryArmSystems = [];
let sourceBoxMeshes = [];
let gantryAttachedSourceBox = null;
let linkStates = [];
let world;
let floorCollider;
let tableCollider;
let colliderHandles = [];
let rigidBodies = [];
let useCanvasFallback = false;
let fallbackContext = null;
let viewerNotice = null;
let webglMode = "unknown";
let gantryFocusIndex = -1;
let backendMode = DEMO_NO_BACKEND ? "demo" : "live";
let lastBackendCall = null;
let demoLastCommand = {
  type: "demo-idle",
  label: "none",
  target: [...DEFAULT_ARM_POSE],
  duration: null,
  stamp: Date.now() / 1000,
  source: "demo",
};
const fallbackCamera = {
  yaw: 0.9,
  pitch: 0.55,
  distance: 2.4,
  target: { x: 0, y: 0, z: 0.45 },
};
const fallbackPointer = {
  dragging: false,
  mode: "orbit",
  x: 0,
  y: 0,
};
const CAMERA_PRESETS = {
  arm: {
    position: [2.1, 1.8, 1.45],
    target: [0, 0, 0.45],
  },
  gantry: {
    position: [9.8, 8.4, 6.4],
    target: [0, 0, 0.85],
  },
};
const assetLoader = createAssetLoader({ THREE, GLTFLoader, OBJLoader, STLLoader });
const sceneItems = {
  arm: true,
  table: false,
  box: false,
  "gantry-source": true,
  "gantry-dest-0": true,
  "gantry-dest-1": true,
  "gantry-dest-2": true,
  "gantry-dest-3": true,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAngle(angle) {
  let value = Number(angle);
  while (value <= -Math.PI) {
    value += Math.PI * 2;
  }
  while (value > Math.PI) {
    value -= Math.PI * 2;
  }
  return value;
}

function radiansToDegrees(angle) {
  return normalizeAngle(angle) * (180 / Math.PI);
}

function degreesToRadians(angle) {
  return normalizeAngle(Number(angle) * (Math.PI / 180));
}

function shortestAngleDelta(from, to) {
  return normalizeAngle(to - from);
}

function formatPositions(positions) {
  return positions.map((value) => Number(value).toFixed(3)).join(", ");
}

function resolveApiPath(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!API_BASE_URL) {
    return normalizedPath;
  }
  return `${API_BASE_URL}${normalizedPath}`;
}

function parseJsonBody(body) {
  if (!body || typeof body !== "string") {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch (_error) {
    return {};
  }
}

function mapCommandEntryToBackend(entry) {
  return {
    type: "trajectory",
    label: entry.label || "command",
    target: Array.isArray(entry.target) ? entry.target : [],
    duration: Number(entry.duration ?? 0),
    stamp: Number(entry.stamp || Date.now()) / 1000,
    source: entry.source || "local-ui",
  };
}

function buildDemoStatus() {
  const nowSec = Date.now() / 1000;
  const positions = localJointPositions.map((value) => normalizeAngle(value));
  return {
    ok: true,
    joint_state: {
      names: JOINT_NAMES,
      positions,
      stamp: nowSec,
      source: "demo-sensor",
    },
    last_command: demoLastCommand,
    command_history: commandHistory.map(mapCommandEntryToBackend),
    predefined_poses: currentPredefinedPoses,
  };
}

async function apiRequest(path, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  const resolvedPath = resolveApiPath(path);
  lastBackendCall = {
    at: Date.now(),
    method,
    path: resolvedPath,
    suppressed: DEMO_NO_BACKEND,
  };

  if (path.startsWith("/api/calibration/")) {
    const response = await fetch(resolvedPath, init);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    return response.json();
  }

  if (DEMO_NO_BACKEND) {
    const payload = parseJsonBody(init.body);
    if (path === "/api/pose") {
      const pose = payload.pose;
      const target = currentPredefinedPoses[pose] || targetJointPositions;
      demoLastCommand = {
        type: "pose",
        label: String(pose || "pose"),
        target: [...target],
        duration: Number(payload.duration ?? 1),
        stamp: Date.now() / 1000,
        source: "demo-no-backend",
      };
    } else if (path === "/api/joints") {
      const target = Array.isArray(payload.positions) ? payload.positions : targetJointPositions;
      demoLastCommand = {
        type: "trajectory",
        label: String(payload.label || "custom"),
        target: [...target],
        duration: Number(payload.duration ?? 1),
        stamp: Date.now() / 1000,
        source: "demo-no-backend",
      };
    }
    return buildDemoStatus();
  }

  const response = await fetch(resolvedPath, init);
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  return response.json();
}

function formatCalibrationNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "n/a";
}

function formatVectorComponent(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "n/a";
}

function calibrationRowSelectionId(row) {
  return String(row?.id ?? row?.created_at ?? "");
}

function loadCalibrationRowSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALIBRATION_ROW_SELECTION_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch (_error) {
    return new Set();
  }
}

function saveCalibrationRowSelection() {
  try {
    localStorage.setItem(
      CALIBRATION_ROW_SELECTION_STORAGE_KEY,
      JSON.stringify([...loadedCalibrationRowIds])
    );
  } catch (_error) {}
}

function setCalibrationRowLoaded(entry, loaded) {
  const rowId = calibrationRowSelectionId(entry);
  if (!rowId) return;
  if (loaded) {
    loadedCalibrationRowIds.add(rowId);
  } else {
    loadedCalibrationRowIds.delete(rowId);
  }
  saveCalibrationRowSelection();
  renderCalibrationRows(availableCalibrationRowsCache);
}

function clearLoadedCalibrationRows() {
  loadedCalibrationRowIds.clear();
  saveCalibrationRowSelection();
  renderCalibrationRows(availableCalibrationRowsCache);
  setSyncStatus("sync-warn", "Loaded calibration readings cleared; saved recordings remain available to check individually.");
}

function renderCalibrationRows(rows) {
  if (!calibrationRows) {
    return;
  }
  availableCalibrationRowsCache = [...(rows || [])];
  const availableIds = new Set(availableCalibrationRowsCache.map(calibrationRowSelectionId));
  loadedCalibrationRowIds = new Set(
    [...loadedCalibrationRowIds].filter((rowId) => availableIds.has(rowId))
  );
  saveCalibrationRowSelection();
  calibrationRowsCache = availableCalibrationRowsCache.filter((entry) => (
    loadedCalibrationRowIds.has(calibrationRowSelectionId(entry))
  ));
  calibrationRows.innerHTML = "";
  if (!availableCalibrationRowsCache.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="12">No calibration poses recorded yet.</td>';
    calibrationRows.appendChild(row);
    renderCalibrationCoverage(calibrationRowsCache);
    return;
  }
  [...availableCalibrationRowsCache].reverse().forEach((entry) => {
    const row = document.createElement("tr");
    const rowId = calibrationRowSelectionId(entry);
    const loaded = loadedCalibrationRowIds.has(rowId);
    row.classList.toggle("calibration-row-unloaded", !loaded);
    const createdAt = entry.created_at ? new Date(entry.created_at).toLocaleTimeString() : "";
    const udpAngles = entry.udp_angles_deg || entry.udp_average_deg || {};
    const snapshot = calibrationSnapshots.get(entry.id);
    const sampleCounts = entry.sample_counts || {};
    const sensors = entry.sensor_readings || {};
    const extraSensors = ["wrist_camera", "wrist_accel", "clamp"]
      .filter((name) => sensors[name])
      .map((name) => `${name}: ${formatCalibrationNumber(sensors[name]?.angle)}`);
    row.innerHTML = `
      <td><input class="calibration-load-toggle" type="checkbox" ${loaded ? "checked" : ""} ${sensorControlLocked ? "disabled" : ""} aria-label="Load recording from ${createdAt || rowId} and reload it next time" /></td>
      <td>${snapshot ? `<img class="calibration-snapshot" src="${snapshot}" alt="Recorded arm orientation" />` : "—"}</td>
      <td>${createdAt}</td>
      <td>${formatCalibrationNumber(udpAngles.base)}</td>
      <td>${formatCalibrationNumber(udpAngles.shoulder)}</td>
      <td>${formatCalibrationNumber(udpAngles.elbow)}</td>
      <td>${formatCalibrationNumber(udpAngles.wrist)}</td>
      <td>${formatCalibrationNumber(entry.targets_deg?.base)}</td>
      <td>${formatCalibrationNumber(entry.targets_deg?.shoulder)}</td>
      <td>${formatCalibrationNumber(entry.targets_deg?.elbow)}</td>
      <td>${formatCalibrationNumber(entry.targets_deg?.wrist)}</td>
      <td>${CALIBRATION_JOINTS.map((joint) => `${joint}: ${sampleCounts[joint] || 0}`).join("<br>")}${extraSensors.length ? `<hr>${extraSensors.join("<br>")}` : ""}</td>
    `;
    row.querySelector(".calibration-load-toggle")?.addEventListener("change", (event) => {
      setCalibrationRowLoaded(entry, event.target.checked);
    });
    calibrationRows.appendChild(row);
  });
  renderCalibrationCoverage(calibrationRowsCache);
}

function renderCalibrationCoverage(rows = calibrationRowsCache) {
  if (!calibrationCoverage) return;
  if (sensorControlLocked && calibrationCompletionSummary) {
    calibrationCoverage.textContent = calibrationCompletionSummary;
    setCalibrationCompletionMessage("sync-ok", calibrationCompletionSummary);
    return;
  }
  if (!rows?.length) {
    if (availableCalibrationRowsCache.length) {
      calibrationCoverage.textContent = `0 loaded · ${availableCalibrationRowsCache.length} saved recording${availableCalibrationRowsCache.length === 1 ? "" : "s"} available. Check Load / reload beside each recording to use it.`;
      setCalibrationCompletionMessage("sync-warn", "No readings loaded. Check at least three saved recordings.");
    } else {
      calibrationCoverage.textContent = "Record at least three varied orientations to finish calibration.";
      setCalibrationCompletionMessage("sync-warn", "Need three recorded orientations.");
    }
    return;
  }
  const ranges = CALIBRATION_JOINTS.map((joint) => {
    const values = rows.map((row) => Number(row.targets_deg?.[joint])).filter(Number.isFinite);
    const span = values.length ? Math.max(...values) - Math.min(...values) : 0;
    return `${joint}: ${span.toFixed(0)}° span`;
  });
  calibrationCoverage.textContent = `${rows.length} loaded / ${availableCalibrationRowsCache.length} saved · ${ranges.join(" · ")}`;
  const readiness = calibrationCompletionReadiness(rows);
  setCalibrationCompletionMessage(readiness.tone, readiness.message);
}

function sampledCalibrationJoints(rows) {
  return CALIBRATION_JOINTS.filter((joint) => (
    rows.some((row) => (
      Number(row.sample_counts?.[joint] || 0) > 0
      && Number.isFinite(Number(row.udp_angles_deg?.[joint]))
    ))
  ));
}

function calibrationCompletionReadiness(rows = calibrationRowsCache) {
  if (rows.length < 3) {
    const remaining = 3 - rows.length;
    return {
      ready: false,
      tone: "sync-warn",
      message: `Need ${remaining} more loaded recording${remaining === 1 ? "" : "s"}; check Load / reload beside saved recordings.`,
    };
  }
  const sampledJoints = sampledCalibrationJoints(rows);
  if (!sampledJoints.length) {
    return {
      ready: false,
      tone: "sync-error",
      message: "Cannot complete: the recorded orientations contain no usable joint-sensor samples.",
    };
  }
  const unsensedJoints = CALIBRATION_JOINTS.filter((joint) => !sampledJoints.includes(joint));
  return {
    ready: true,
    tone: unsensedJoints.length ? "sync-warn" : "sync-ok",
    message: unsensedJoints.length
      ? `Ready. Sensor data: ${sampledJoints.join(", ")}. Fixed at final pose: ${unsensedJoints.join(", ")}.`
      : `Ready to complete calibration for ${sampledJoints.join(", ")}.`,
  };
}

function renderCalibrationStatus(payload) {
  if (!calibrationStatus) {
    return;
  }
  const averages = payload?.averages || {};
  const latest = payload?.latest || {};
  const latestValues = CALIBRATION_JOINTS.map((joint) => {
    const reading = latest[joint];
    const sensor = reading?.port_label || "no sensor";
    const hz = Number(reading?.sample_hz);
    const rate = Number.isFinite(hz) ? `, ${hz.toFixed(0)} Hz` : "";
    return `${joint}: ${formatCalibrationNumber(reading?.angle)} (${sensor}${rate})`;
  });
  const averageValues = CALIBRATION_JOINTS.map((joint) => {
    const average = averages[joint];
    const count = average?.count || 0;
    const sensorCount = average?.sensor_count || 0;
    const sensor = average?.port_label || "no sensor";
    const method = average?.average_method === "arithmetic" ? ", standard avg" : "";
    return `${joint}: ${formatCalibrationNumber(average?.angle)} (${count} samples from ${sensorCount} sensor${sensorCount === 1 ? "" : "s"}, ${sensor}${method})`;
  });
  const targetValues = payload?.targets_deg
    ? CALIBRATION_JOINTS.map((joint) => `${joint}=${payload.targets_deg[joint]}`).join(", ")
    : "base=0, shoulder=0, elbow=0, wrist=0";
  const udp = payload?.udp;
  const sourceLabel = payload?.source_mode || calibrationSourceSelect?.value || "both";
  const udpLabel = udp ? `UDP ${udp.host}:${udp.port}${udp.error ? ` error: ${udp.error}` : ""}` : "UDP status unavailable";
  const nanoValues = [];
  if (latest.wrist_camera) {
    nanoValues.push(`wrist camera: ${formatCalibrationNumber(latest.wrist_camera.angle)}`);
  }
  if (latest.wrist_accel) {
    nanoValues.push(`wrist accel: ${formatCalibrationNumber(latest.wrist_accel.angle)}`);
  }
  if (latest.clamp) {
    nanoValues.push(`clamp: ${formatCalibrationNumber(latest.clamp.angle)} raw=${latest.clamp.raw_angle ?? "n/a"}`);
  }
  const nanoText = nanoValues.length ? ` | Nano: ${nanoValues.join(" | ")}` : "";
  calibrationStatus.textContent = `Source: ${sourceLabel} | ${udpLabel} | Best 5-reading estimates: ${latestValues.join(" | ")}${nanoText} | Sensor windows: ${averageValues.join(" | ")} | Calibration joint row: ${targetValues}`;
  renderLiveInputFeeds(payload);
}

function liveFeedAge(reading) {
  const age = Date.now() - Number(reading?.received_at_ms || 0);
  return Number.isFinite(age) && age >= 0 ? `${Math.round(age)} ms ago` : "waiting";
}

function liveFeedTiming(reading) {
  const averageMs = Number(reading?.average_interval_ms);
  const sampleCount = Number(reading?.timing_sample_count || 0);
  if (!Number.isFinite(averageMs) || sampleCount < 2) {
    return `interval avg collecting (${sampleCount}/10)`;
  }
  const digits = averageMs < 10 ? 2 : averageMs < 100 ? 1 : 0;
  return `interval avg ${averageMs.toFixed(digits)} ms (${sampleCount}/10)`;
}

function recordBaseCameraDisplayAngle(reading) {
  if (Number(reading?.camera) !== 0) return;
  const angle = Number(reading?.angle);
  if (!Number.isFinite(angle)) return;
  const frame = reading?.frame ?? reading?.received_at_ms;
  if (frame == null || frame === baseCameraDisplayHistory.lastFrame) return;
  if (
    Number.isFinite(Number(frame))
    && Number.isFinite(Number(baseCameraDisplayHistory.lastFrame))
    && Number(frame) < Number(baseCameraDisplayHistory.lastFrame)
  ) {
    baseCameraDisplayHistory.samples = [];
  }
  baseCameraDisplayHistory.lastFrame = frame;
  baseCameraDisplayHistory.samples.push(angle);
  if (baseCameraDisplayHistory.samples.length > 10) {
    baseCameraDisplayHistory.samples.splice(0, baseCameraDisplayHistory.samples.length - 10);
  }
}

function baseCameraStandardAverage(windowSize) {
  const samples = baseCameraDisplayHistory.samples.slice(-windowSize);
  if (!samples.length) return { angle: null, count: 0 };
  return {
    angle: samples.reduce((sum, angle) => sum + angle, 0) / samples.length,
    count: samples.length,
  };
}

function liveFeedAngleAverage(reading, windowSize) {
  const legacyAverage = windowSize === 10 ? reading?.average_angle_deg : undefined;
  const legacyCount = windowSize === 10 ? reading?.angle_sample_count : undefined;
  const baseStats = Number(reading?.camera) === 0
    ? baseCameraStandardAverage(windowSize)
    : null;
  const averageAngle = Number(
    baseStats?.angle ?? reading?.[`average_angle_${windowSize}_deg`] ?? legacyAverage
  );
  const sampleCount = Number(
    baseStats?.count ?? reading?.[`angle_sample_count_${windowSize}`] ?? legacyCount ?? 0
  );
  const averageLabel = Number(reading?.camera) === 0 || reading?.average_method === "arithmetic"
    ? "standard avg"
    : "angle avg";
  if (!Number.isFinite(averageAngle) || sampleCount === 0) {
    return `${windowSize}-sample ${averageLabel} collecting (${sampleCount}/${windowSize})`;
  }
  return `${windowSize}-sample ${averageLabel} ${formatCalibrationNumber(averageAngle)}° (${sampleCount}/${windowSize})`;
}

function liveFeedRow(label, detail, reading, angleWindows = [10]) {
  const fresh = Number(reading?.received_at_ms) > 0 && Date.now() - Number(reading.received_at_ms) < 2000;
  const angleAverages = angleWindows.map((windowSize) => liveFeedAngleAverage(reading, windowSize));
  const status = fresh
    ? `${angleAverages.join(" · ")} · ${liveFeedTiming(reading)} · ${liveFeedAge(reading)}`
    : "no usable data";
  return `<div class="live-feed-row ${fresh ? "live-feed-ok" : "live-feed-missing"}"><strong>${label}</strong><span>${detail}</span><small>${status}</small></div>`;
}

function cameraFeedIndices(payload) {
  const cameraFeeds = payload?.camera_feeds || {};
  const liveIndices = Object.keys(cameraFeeds)
    .map((key) => Number.parseInt(key, 10))
    .filter(Number.isFinite);
  return [...new Set([...DEFAULT_CAMERA_FEEDS, ...liveIndices])].sort((a, b) => a - b);
}

function createAccelerometerLabel() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  }));
  sprite.scale.set(0.48, 0.06, 1);
  sprite.position.set(0, 0, 0.13);
  sprite.renderOrder = 20;
  return { canvas, context, texture, sprite, text: "" };
}

function drawAccelerometerLabel(label, text) {
  if (!label.context || label.text === text) return;
  label.text = text;
  const { canvas, context } = label;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(7, 17, 31, 0.9)";
  context.fillRect(0, 10, canvas.width, canvas.height - 20);
  context.strokeStyle = "rgba(124, 209, 255, 0.85)";
  context.lineWidth = 4;
  context.strokeRect(2, 12, canvas.width - 4, canvas.height - 24);
  context.fillStyle = "#e7edf3";
  context.font = "600 38px IBM Plex Sans, Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 34);
  label.texture.needsUpdate = true;
}

function createAccelerometerArrow(direction, length, color, headLength, headWidth) {
  const arrow = new THREE.ArrowHelper(
    direction,
    new THREE.Vector3(),
    length,
    color,
    headLength,
    headWidth
  );
  // WebGL line width is fixed to one pixel on most platforms. A cylinder gives
  // the vector shaft real 3D thickness that can be scaled with the control.
  arrow.line.visible = false;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 12),
    new THREE.MeshBasicMaterial({ color })
  );
  shaft.name = "vector-shaft";
  arrow.add(shaft);
  arrow.userData.shaft = shaft;
  return arrow;
}

function setAccelerometerArrowDimensions(arrow, length, headLength, headWidth) {
  const scaledLength = length * accelerometerVectorScale;
  const scaledHeadLength = Math.min(headLength * accelerometerVectorScale, scaledLength * 0.9);
  const scaledHeadWidth = headWidth * accelerometerVectorScale;
  arrow.setLength(scaledLength, scaledHeadLength, scaledHeadWidth);

  const shaftLength = Math.max(0.001, scaledLength - scaledHeadLength);
  const shaftRadius = Math.max(0.0008, scaledHeadWidth * 0.22);
  arrow.userData.shaft.position.set(0, shaftLength / 2, 0);
  arrow.userData.shaft.scale.set(shaftRadius, shaftLength, shaftRadius);
}

function createAccelerometerVisual(feedKey, config) {
  if (!armSceneGroup || useCanvasFallback) return null;
  const jointState = linkStates[config.jointIndex];
  if (!jointState) return null;
  const group = new THREE.Group();
  group.name = `accelerometer-vector-${feedKey}`;
  group.position.set(...config.position);
  group.rotation.set(...config.rotation);

  const axes = new THREE.AxesHelper(0.085);
  axes.material.depthTest = false;
  axes.material.transparent = true;
  axes.material.opacity = 0.5;
  axes.renderOrder = 9;
  group.add(axes);

  const componentArrows = {
    x: createAccelerometerArrow(new THREE.Vector3(1, 0, 0), 0.06, ACCELEROMETER_VECTOR_COLORS.x, 0.016, 0.008),
    y: createAccelerometerArrow(new THREE.Vector3(0, 1, 0), 0.06, ACCELEROMETER_VECTOR_COLORS.y, 0.016, 0.008),
    z: createAccelerometerArrow(new THREE.Vector3(0, 0, 1), 0.06, ACCELEROMETER_VECTOR_COLORS.z, 0.016, 0.008),
  };
  Object.values(componentArrows).forEach((arrow) => group.add(arrow));

  const resultantArrow = createAccelerometerArrow(
    new THREE.Vector3(0, 0, 1),
    0.1,
    ACCELEROMETER_VECTOR_COLORS.resultant,
    0.022,
    0.011
  );
  group.add(resultantArrow);

  const label = createAccelerometerLabel();
  group.add(label.sprite);
  group.visible = false;
  // Parenting to the pivot keeps raw X/Y/Z in the sensor-local frame while
  // carrying that entire frame with the physical joint as the arm moves.
  jointState.pivot.add(group);

  const visual = {
    feedKey,
    config,
    group,
    componentArrows,
    resultantArrow,
    label,
    acceleration: null,
    receivedAtMs: 0,
  };
  accelerometerVisuals.set(feedKey, visual);
  return visual;
}

function setComponentArrow(arrow, axis, value) {
  const magnitude = Math.abs(Number(value));
  if (!Number.isFinite(magnitude) || magnitude < 0.005) {
    arrow.visible = false;
    return;
  }
  arrow.visible = true;
  const direction = axis.clone().multiplyScalar(Number(value) < 0 ? -1 : 1);
  const length = 0.018 + Math.min(2, magnitude) * 0.045;
  arrow.setDirection(direction);
  setAccelerometerArrowDimensions(
    arrow,
    length,
    Math.min(0.016, length * 0.32),
    Math.min(0.008, length * 0.16)
  );
}

function applyAccelerometerVectorDimensions(visual) {
  if (!visual.acceleration) return;
  const { x, y, z } = visual.acceleration;
  setComponentArrow(visual.componentArrows.x, new THREE.Vector3(1, 0, 0), x);
  setComponentArrow(visual.componentArrows.y, new THREE.Vector3(0, 1, 0), y);
  setComponentArrow(visual.componentArrows.z, new THREE.Vector3(0, 0, 1), z);

  const resultant = new THREE.Vector3(x, y, z);
  const magnitude = resultant.length();
  visual.resultantArrow.visible = magnitude >= 0.005;
  if (visual.resultantArrow.visible) {
    visual.resultantArrow.setDirection(resultant.normalize());
    const length = 0.025 + Math.min(2, magnitude) * 0.065;
    setAccelerometerArrowDimensions(
      visual.resultantArrow,
      length,
      Math.min(0.022, length * 0.3),
      Math.min(0.011, length * 0.15)
    );
  }
}

function updateAccelerometerVisuals(feeds) {
  Object.entries(ACCELEROMETER_3D_CONFIG).forEach(([feedKey, config]) => {
    const reading = feeds?.[feedKey];
    const accel = reading?.accel;
    const values = [Number(accel?.x), Number(accel?.y), Number(accel?.z)];
    if (!values.every(Number.isFinite)) return;

    const [x, y, z] = values;
    const receivedAtMs = Number(reading.received_at_ms || Date.now());
    accelerometerReadings.set(feedKey, {
      acceleration: { x, y, z },
      receivedAtMs,
    });

    const visual = accelerometerVisuals.get(feedKey)
      || createAccelerometerVisual(feedKey, config);
    if (!visual) return;

    visual.acceleration = { x, y, z };
    applyAccelerometerVectorDimensions(visual);

    visual.receivedAtMs = receivedAtMs;
    drawAccelerometerLabel(
      visual.label,
      `${config.joint.toUpperCase()} ${feedKey}  X ${x.toFixed(2)}  Y ${y.toFixed(2)}  Z ${z.toFixed(2)} g`
    );
  });
}

function updateAccelerometerVisualPositions() {
  accelerometerVisuals.forEach((visual) => {
    const state = linkStates[visual.config.jointIndex];
    const fresh = Date.now() - visual.receivedAtMs < 2000;
    visual.group.visible = accelerometerVisualsVisible && fresh && currentSceneId === "arm";
    if (!state || visual.group.parent === state.pivot) return;
    state.pivot.add(visual.group);
    visual.group.position.set(...visual.config.position);
    visual.group.rotation.set(...visual.config.rotation);
  });
}

function setAccelerometerVisualsVisible(visible) {
  accelerometerVisualsVisible = Boolean(visible);
  if (toggleAccelerometerVectorsButton) {
    toggleAccelerometerVectorsButton.textContent = accelerometerVisualsVisible
      ? "Hide MPU XYZ"
      : "Show MPU XYZ";
  }
  if (accelerometer3dLegend) accelerometer3dLegend.hidden = !accelerometerVisualsVisible;
  updateAccelerometerVisualPositions();
}

function renderLiveInputFeeds(payload) {
  const cameraIndices = cameraFeedIndices(payload);

  if (liveCameraFeeds) {
    const feeds = payload?.camera_feeds || {};
    liveCameraFeeds.innerHTML = cameraIndices.map((camera) => {
      const reading = feeds[String(camera)];
      recordBaseCameraDisplayAngle(reading);
      const angle = formatCalibrationNumber(reading?.angle);
      const details = reading
        ? `${angle}° · base joint · angle codes ${reading.codes ?? reading.pairs ?? 0} · ring positions ${reading.ring_positions ?? reading.expected_pairs ?? "?"} · markers ${reading.markers ?? 0}`
        : "waiting for this camera";
      return liveFeedRow(`Camera ${camera}`, details, reading);
    }).join("");
  }
  if (liveAccelerometerFeeds) {
    const accelerometers = payload?.accelerometers || {};
    const feeds = payload?.accelerometer_feeds || accelerometers.feeds || {};
    const nanos = payload?.nanos || accelerometers.nanos || {};
    const expectedFeeds = ["dual:0x68", "dual:0x69", "single:0x68"];
    const keys = [...new Set([...expectedFeeds, ...Object.keys(feeds)])];
    updateAccelerometerVisuals(feeds);
    liveAccelerometerFeeds.innerHTML = keys.map((key) => {
      const reading = feeds[key];
      const accel = reading?.accel;
      const board = key.split(":")[0];
      const raw = accel
        ? `raw [${formatVectorComponent(accel.x)}, ${formatVectorComponent(accel.y)}, ${formatVectorComponent(accel.z)}]`
        : nanos[board]?.last_line
          ? "serial connected, but no valid raw MPU packet"
          : "waiting for this accelerometer";
      const polynomialCount = Number(reading?.polynomial_sample_count || 0);
      const polynomialWindow = Number(reading?.polynomial_window_size || 10);
      const polynomialDegree = Number(reading?.polynomial_degree ?? 1);
      const polynomialState = reading?.polynomial_angle_deg != null
        && Number.isFinite(Number(reading.polynomial_angle_deg))
        ? `LS degree ${polynomialDegree}, ${polynomialCount}/${polynomialWindow}`
        : `LS collecting ${polynomialCount}/${polynomialWindow}`;
      return liveFeedRow(
        key,
        `${formatCalibrationNumber(reading?.angle)}° estimate · raw angle ${formatCalibrationNumber(reading?.raw_angle)}° · ${polynomialState} · ${raw}`,
        reading,
        [10, 100]
      );
    }).join("");
  }
}

function liveUdpAnglesFromPayload(payload) {
  const latest = payload?.latest || {};
  const angles = {};
  for (const joint of CALIBRATION_JOINTS) {
    const angle = Number(latest[joint]?.angle);
    if (Number.isFinite(angle)) {
      angles[joint] = angle;
    }
  }
  return Object.keys(angles).length ? angles : null;
}

function getCalibrationTargetAngles() {
  const targets = {};
  CALIBRATION_JOINTS.forEach((joint) => {
    const value = Number(calibrationTargetInputs[joint]?.value);
    targets[joint] = Number.isFinite(value) ? value : DEFAULT_CALIBRATION_TARGETS_DEG[joint];
  });
  return targets;
}

function calibrationTargetsFromArmPositions(positions) {
  return {
    base: radiansToDegrees(positions[0]),
    shoulder: -radiansToDegrees(positions[1]),
    elbow: radiansToDegrees(positions[3]),
    wrist: -radiansToDegrees(positions[5]),
  };
}

function setCalibrationTargetInputs(targets) {
  CALIBRATION_JOINTS.forEach((joint) => {
    const input = calibrationTargetInputs[joint];
    const value = Number(targets?.[joint]);
    if (input && Number.isFinite(value)) {
      input.value = String(value);
    }
  });
}

function udpAnglesChanged(angles) {
  if (!lastAppliedUdpAngles) {
    return true;
  }
  return Object.keys(angles).some((joint) => (
    !Number.isFinite(lastAppliedUdpAngles[joint])
    || Math.abs(angles[joint] - lastAppliedUdpAngles[joint]) > UDP_ARM_CHANGE_EPSILON_DEG
  ));
}

function shortestDegreesDelta(from, to) {
  let delta = Number(to) - Number(from);
  while (delta <= -180) {
    delta += 360;
  }
  while (delta > 180) {
    delta -= 360;
  }
  return delta;
}

function fitLinearCalibrationModel(samples) {
  if (samples.length < 2) {
    return null;
  }
  const inputReferenceDeg = samples[0].sensor;
  let previousSensorDeg = inputReferenceDeg;
  let unwrappedSensorDeg = inputReferenceDeg;
  const points = samples.map((sample, index) => {
    if (index > 0) {
      unwrappedSensorDeg += shortestDegreesDelta(previousSensorDeg, sample.sensor);
      previousSensorDeg = sample.sensor;
    }
    return { sensor: unwrappedSensorDeg, target: sample.target };
  });
  const meanSensor = points.reduce((sum, point) => sum + point.sensor, 0) / points.length;
  const meanTarget = points.reduce((sum, point) => sum + point.target, 0) / points.length;
  let variance = 0;
  let covariance = 0;
  points.forEach((point) => {
    const sensorDelta = point.sensor - meanSensor;
    variance += sensorDelta * sensorDelta;
    covariance += sensorDelta * (point.target - meanTarget);
  });
  if (variance < 0.25) {
    return null;
  }
  const slope = covariance / variance;
  return {
    inputReferenceDeg,
    slope,
    intercept: meanTarget - slope * meanSensor,
    sampleCount: points.length,
  };
}

function fitCalibrationModels(rows, sourceMode) {
  const models = {};
  CALIBRATION_JOINTS.forEach((joint) => {
    const samples = rows
      .filter((row) => !row.source_mode || row.source_mode === sourceMode)
      .map((row) => ({
        sensor: Number(row.udp_angles_deg?.[joint]),
        target: Number(row.targets_deg?.[joint]),
      }))
      .filter((sample) => Number.isFinite(sample.sensor) && Number.isFinite(sample.target));
    const model = fitLinearCalibrationModel(samples);
    if (model) {
      models[joint] = model;
    }
  });
  return models;
}

function calibratedTargetFromSensor(joint, sensorAngle) {
  const model = calibratedSensorModels?.[joint];
  if (!model || !Number.isFinite(Number(sensorAngle))) {
    return null;
  }
  const unwrappedSensor = model.inputReferenceDeg
    + shortestDegreesDelta(model.inputReferenceDeg, Number(sensorAngle));
  return model.intercept + model.slope * unwrappedSensor;
}

function armPositionsFromUdpAngles(angles) {
  const positions = [...getDisplayedPositions()];
  while (positions.length < JOINT_NAMES.length) {
    positions.push(0);
  }
  Object.entries(UDP_TO_ARM_JOINTS).forEach(([joint, mapping]) => {
    const liveAngle = angles[joint];
    const referenceAngle = calibratedUdpReferenceAngles[joint];
    if (!Number.isFinite(Number(liveAngle))) {
      return;
    }
    if (!Number.isFinite(Number(referenceAngle))) {
      return;
    }
    const fittedTarget = calibratedTargetFromSensor(joint, liveAngle);
    if (Number.isFinite(fittedTarget)) {
      positions[mapping.index] = degreesToRadians(fittedTarget * mapping.sign);
      return;
    }
    const targetAngle = calibratedTargetAngles[joint] ?? DEFAULT_CALIBRATION_TARGETS_DEG[joint] ?? 0;
    const delta = shortestDegreesDelta(referenceAngle, liveAngle);
    positions[mapping.index] = degreesToRadians((targetAngle + delta) * mapping.sign);
  });
  return positions.map((value) => normalizeAngle(value));
}

function hasAllCalibrationSamples(row) {
  return CALIBRATION_JOINTS.some(
    (joint) => Number(row?.sample_counts?.[joint] || 0) > 0
  );
}

function adoptCalibrationReference(row, pinSyncStatus = false) {
  if (!row || !hasAllCalibrationSamples(row)) {
    return false;
  }
  const nextReferenceId = row.id ?? row.created_at ?? JSON.stringify(row.udp_angles_deg || {});
  if (calibratedReferenceId === nextReferenceId) {
    return true;
  }
  calibratedReferenceId = nextReferenceId;
  calibratedUdpReferenceAngles = { ...(row.udp_angles_deg || {}) };
  calibratedTargetAngles = {
    ...DEFAULT_CALIBRATION_TARGETS_DEG,
    ...(row.targets_deg || {}),
  };
  setCalibrationTargetInputs(calibratedTargetAngles);
  lastAppliedUdpAngles = null;
  if (pinSyncStatus) {
    udpCalibrationSyncPinned = true;
    setSyncStatus("sync-ok", "Synced with robot via UDP");
  }
  return true;
}

function applyLiveUdpArmPose(payload) {
  if (preCalibrationActive) return;
  adoptCalibrationReference(payload?.calibration_reference, true);
  const angles = liveUdpAnglesFromPayload(payload);
  if (!calibratedUdpReferenceAngles || !angles || !udpAnglesChanged(angles)) {
    return;
  }

  const positions = armPositionsFromUdpAngles(angles);
  const blendStart = [...getDisplayedPositions()];
  lastAppliedUdpAngles = { ...angles };
  sensorBlend = {
    start: blendStart,
    target: [...positions],
    startedAt: performance.now(),
    duration: 60,
  };
  targetJointPositions = [...positions];
  backendSmoothingInitialized = true;
  activeMotion = null;

  if (lastStatus?.joint_state) {
    lastStatus = {
      ...lastStatus,
      joint_state: {
        ...lastStatus.joint_state,
        positions: [...positions],
        stamp: Date.now() / 1000,
        source: "udp-calibration",
      },
    };
  }

  setJointValues(positions);
  udpCalibrationSyncPinned = true;
  setSyncStatus("sync-ok", "Sensor control locked — arm following calibrated live sensors.");
}

async function fetchCalibrationStatus() {
  if (!calibrationStatus && !calibrationRows) {
    return;
  }
  try {
    const sourceMode = calibrationSourceSelect?.value || "both";
    const payload = await apiRequest(`/api/calibration/status?source=${encodeURIComponent(sourceMode)}`);
    renderCalibrationStatus(payload);
    renderCalibrationRows(payload.rows || []);
    applyLiveUdpArmPose(payload);
  } catch (error) {
    if (calibrationStatus) {
      calibrationStatus.textContent = `Calibration bridge unavailable: ${error.message}`;
    }
  }
}

async function loadCalibrationForBrowser() {
  cancelAutomaticCalibrationCapture();
  calibrationSnapshots.clear();
  calibratedReferenceId = null;
  calibratedUdpReferenceAngles = null;
  calibratedSensorModels = null;
  lastAppliedUdpAngles = null;
  udpCalibrationSyncPinned = false;
  preCalibrationActive = true;
  sensorBlend = null;
  setSensorControlLocked(false);

  const sourceMode = calibrationSourceSelect?.value || "both";
  const payload = await apiRequest(`/api/calibration/status?source=${encodeURIComponent(sourceMode)}`);
  renderCalibrationStatus(payload);
  renderCalibrationRows(payload.rows || []);
  const rowCount = payload.rows?.length || 0;
  const loadedCount = calibrationRowsCache.length;
  setSyncStatus(
    "sync-warn",
    rowCount
      ? `${rowCount} saved calibration orientation${rowCount === 1 ? "" : "s"} available; ${loadedCount} checked and loaded.`
      : "No calibration orientations recorded yet."
  );
}

function connectCalibrationStream() {
  calibrationEventSource?.close();
  const sourceMode = calibrationSourceSelect?.value || "both";
  const streamPath = resolveApiPath(
    `/api/calibration/stream?source=${encodeURIComponent(sourceMode)}`
  );
  calibrationEventSource = new EventSource(streamPath);
  calibrationEventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      renderCalibrationStatus(payload);
      applyLiveUdpArmPose(payload);
    } catch (error) {
      console.warn("Invalid calibration stream event", error);
    }
  };
  calibrationEventSource.onerror = () => {
    if (calibrationStatus) {
      calibrationStatus.textContent = "Calibration stream reconnecting…";
    }
  };
}

async function captureCalibrationRow({
  label = "arm-calibration",
  targets = calibrationTargetsFromArmPositions(getDisplayedPositions()),
  automatic = false,
} = {}) {
  if (calibrateCurrentButton) {
    calibrateCurrentButton.disabled = true;
  }
  try {
    setCalibrationTargetInputs(targets);
    const snapshot = viewerCanvas.toDataURL("image/jpeg", 0.72);
    const payload = await apiRequest("/api/calibration/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label,
        source_mode: calibrationSourceSelect?.value || "both",
        targets_deg: targets,
      }),
    });
    renderCalibrationStatus(payload);
    if (payload.row?.id) calibrationSnapshots.set(payload.row.id, snapshot);
    renderCalibrationRows(payload.rows || []);
    const rowNumber = payload.rows?.length || 1;
    setSyncStatus(
      "sync-warn",
      automatic
        ? `Automatically saved calibration pose ${rowNumber}; check Load / reload to use it.`
        : `Saved calibration pose ${rowNumber}; check Load / reload to use it.`
    );
  } catch (error) {
    if (calibrationStatus) {
      calibrationStatus.textContent = `Calibration failed: ${error.message}`;
    }
  } finally {
    if (calibrateCurrentButton) {
      calibrateCurrentButton.disabled = sensorControlLocked;
    }
  }
}

function cancelAutomaticCalibrationCapture() {
  if (automaticCalibrationCaptureTimer !== null) {
    window.clearTimeout(automaticCalibrationCaptureTimer);
    automaticCalibrationCaptureTimer = null;
  }
  pendingAutomaticCalibrationCapture = null;
  automaticCalibrationCaptureId += 1;
}

async function runAutomaticCalibrationCapture() {
  automaticCalibrationCaptureTimer = null;
  const capture = pendingAutomaticCalibrationCapture;
  if (!capture || !preCalibrationActive || capture.id !== automaticCalibrationCaptureId) {
    return;
  }
  if (automaticCalibrationCaptureInFlight) {
    automaticCalibrationCaptureTimer = window.setTimeout(runAutomaticCalibrationCapture, 100);
    return;
  }

  pendingAutomaticCalibrationCapture = null;
  automaticCalibrationCaptureInFlight = true;
  try {
    await captureCalibrationRow({
      label: `auto-${capture.label}`,
      targets: capture.targets,
      automatic: true,
    });
  } finally {
    automaticCalibrationCaptureInFlight = false;
  }
}

function queueAutomaticCalibrationCapture(positions, durationSec, label) {
  if (!preCalibrationActive) {
    return;
  }

  cancelAutomaticCalibrationCapture();
  setCalibrationTargetInputs(calibrationTargetsFromArmPositions(positions));
}

function moveToCalibrationOrientation() {
  if (blockManualMotionWhileSensorLocked()) return;
  const positions = getJointValues().map((value) => normalizeAngle(value));
  updateArmKinematics(positions);
  updateCollisionState();
  if (collisionState.active) {
    setSyncStatus("sync-error", `Calibration move blocked: ${collisionState.messages.join(" | ")}`);
    return;
  }
  setCalibrationTargetInputs(calibrationTargetsFromArmPositions(positions));
  sendCustomButton.click();
  setSyncStatus("sync-warn", "Moving to pre-calibration orientation; sensor data will be recorded after the arm settles.");
}

function finishCalibrationSession() {
  setCalibrationCompletionMessage("sync-warn", "Checking calibration recordings…");
  try {
    const rows = calibrationRowsCache;
    const readiness = calibrationCompletionReadiness(rows);
    if (!readiness.ready) {
      setSyncStatus("sync-error", readiness.message);
      setCalibrationCompletionMessage("sync-error", readiness.message);
      return;
    }
    const sampledJoints = sampledCalibrationJoints(rows);
    const unsensedJoints = CALIBRATION_JOINTS.filter((joint) => !sampledJoints.includes(joint));
    const lastRow = rows[rows.length - 1];
    localJointPositions = [...getDisplayedPositions()];
    cancelAutomaticCalibrationCapture();
    preCalibrationActive = false;
    calibratedSensorModels = fitCalibrationModels(
      rows,
      calibrationSourceSelect?.value || "both"
    );
    adoptCalibrationReference(lastRow, true);
    const fittedJoints = Object.keys(calibratedSensorModels);
    const referenceOnlyJoints = sampledJoints.filter((joint) => !fittedJoints.includes(joint));
    const modelSummary = fittedJoints.length
      ? ` Fitted sensor-to-model mapping: ${fittedJoints.join(", ")}.`
      : " Using the final pose as the sensor reference.";
    const unsensedSummary = unsensedJoints.length
      ? ` No sensor samples for ${unsensedJoints.join(", ")}; ${unsensedJoints.length === 1 ? "it remains" : "they remain"} fixed at the final pose.`
      : "";
    const referenceOnlySummary = referenceOnlyJoints.length
      ? ` ${referenceOnlyJoints.join(", ")} did not vary enough for a fitted mapping and will use final-pose reference tracking.`
      : "";
    calibrationCompletionSummary = `Calibration complete: ${rows.length} orientations, sensor control locked.${unsensedSummary}${referenceOnlySummary}`;
    setSensorControlLocked(true);
    setSyncStatus(
      "sync-ok",
      `Calibration finished with ${rows.length} recorded orientations.${modelSummary}${unsensedSummary}${referenceOnlySummary} Sensor control is now locked.`
    );
    setCalibrationCompletionMessage("sync-ok", calibrationCompletionSummary);
    renderCalibrationCoverage(rows);
    void fetchCalibrationStatus();
  } catch (error) {
    console.error("Complete calibration failed", error);
    const message = `Complete Calibration failed: ${error?.message || String(error)}`;
    preCalibrationActive = true;
    setSensorControlLocked(false);
    setSyncStatus("sync-error", message);
    setCalibrationCompletionMessage("sync-error", message);
  }
}

async function uncalibrateCurrentPose() {
  if (uncalibrateCurrentButton) {
    uncalibrateCurrentButton.disabled = true;
  }
  try {
    const payload = await apiRequest("/api/calibration/uncalibrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_mode: calibrationSourceSelect?.value || "both",
      }),
    });
    calibratedReferenceId = null;
    cancelAutomaticCalibrationCapture();
    preCalibrationActive = true;
    calibratedUdpReferenceAngles = null;
    calibratedSensorModels = null;
    lastAppliedUdpAngles = null;
    udpCalibrationSyncPinned = false;
    sensorBlend = null;
    setSensorControlLocked(false);
    renderCalibrationStatus(payload);
    renderCalibrationRows(payload.rows || []);
    setSyncStatus("sync-warn", "Uncalibrated — position arm and calibrate again");
  } catch (error) {
    if (calibrationStatus) {
      calibrationStatus.textContent = `Uncalibrate failed: ${error.message}`;
    }
  } finally {
    if (uncalibrateCurrentButton) {
      uncalibrateCurrentButton.disabled = !sensorControlLocked;
    }
  }
}

function renderCommandHistory() {
  if (!commandHistory.length) {
    commandLog.textContent = "No commands sent yet.";
    return;
  }

  commandLog.innerHTML = "";
  [...commandHistory].reverse().forEach((entry) => {
    const item = document.createElement("div");
    item.className = "command-entry";
    item.innerHTML = `
      <strong>${entry.label}${entry.source ? ` · ${entry.source}` : ""}</strong>
      <span>Duration: ${entry.duration.toFixed(2)}s</span>
      <span>Target: ${formatPositions(entry.target)}</span>
      <span>Sent: ${new Date(entry.stamp).toLocaleTimeString()}</span>
    `;
    commandLog.appendChild(item);
  });
}

function renderItemStatus() {
  if (!itemStatus) {
    return;
  }
  itemStatus.innerHTML = "";
  Object.entries(sceneItems).forEach(([key, present]) => {
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <strong>${key}</strong>
      <span>${present ? "Present ✓" : "Absent"}</span>
    `;
    itemStatus.appendChild(row);
  });
}

function renderSceneItemSelect() {
  if (!sceneItemSelect) return;
  sceneItemSelect.innerHTML = "";
  Object.keys(sceneItems).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
    sceneItemSelect.appendChild(option);
  });
}

function setImportedModelStatus(message) {
  if (importedModelStatus) {
    importedModelStatus.textContent = message;
  }
}

function renderImportedModelList() {
  if (!importedModelSelect) {
    return;
  }
  importedModelSelect.innerHTML = "";
  if (!importedModels.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models imported";
    importedModelSelect.appendChild(option);
    setImportedModelStatus("No imported models in scene.");
    return;
  }

  importedModels.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.name} (${entry.sceneId})`;
    importedModelSelect.appendChild(option);
  });
  importedModelSelect.value = importedModels[importedModels.length - 1].id;
  setImportedModelStatus(`${importedModels.length} imported model(s) in scene.`);
}

function disposeObject3D(root) {
  root.traverse((node) => {
    if (node.geometry) {
      node.geometry.dispose();
    }
    if (node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach((mat) => mat?.dispose?.());
    }
  });
}

function getImportParentGroup() {
  if (currentSceneId === "arm" && armSceneGroup) {
    return armSceneGroup;
  }
  return gantrySceneGroup;
}

function placeImportedModel(root) {
  const objectBounds = new THREE.Box3().setFromObject(root);
  if (!objectBounds.isEmpty()) {
    const size = objectBounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-5);
    const targetMaxDim = currentSceneId === "gantry" ? 1.0 : 0.35;
    const scale = targetMaxDim / maxDim;
    root.scale.multiplyScalar(scale);

    const scaledBounds = new THREE.Box3().setFromObject(root);
    const center = scaledBounds.getCenter(new THREE.Vector3());
    const min = scaledBounds.min.clone();
    root.position.x -= center.x;
    root.position.y -= center.y;
    root.position.z -= min.z;
  }

  const parent = getImportParentGroup();
  if (currentSceneId === "gantry") {
    root.position.x += SOURCE_GANTRY_CENTER.x;
    root.position.y += SOURCE_GANTRY_CENTER.y;
    root.position.z += 0.01;
  } else {
    root.position.x += ENVIRONMENT.tableCenter.x;
    root.position.y += ENVIRONMENT.tableCenter.y;
    root.position.z += ENVIRONMENT.tableCenter.z + ENVIRONMENT.tableSize.z * 0.5;
  }
  parent?.add(root);
  return parent;
}

async function loadImportedModelFromFile(file) {
  return assetLoader.loadFromFile(file);
}

async function handleImportModelFile(file) {
  if (!file) {
    setImportedModelStatus("No file selected.");
    return;
  }
  if (!scene || !armSceneGroup || !gantrySceneGroup) {
    setImportedModelStatus("Scene not ready yet; try again.");
    return;
  }
  if (useCanvasFallback) {
    setImportedModelStatus("Model import needs WebGL mode; canvas fallback cannot render imported meshes.");
    return;
  }

  setImportedModelStatus(`Importing ${file.name}...`);
  if (importModelButton) {
    importModelButton.disabled = true;
  }
  try {
    const loaded = await loadImportedModelFromFile(file);
    if (!loaded) {
      throw new Error("Failed to parse model.");
    }
    const container = new THREE.Group();
    container.add(loaded);
    container.name = `imported-${file.name}`;
    const parent = placeImportedModel(container);
    const id = `model-${++importedModelCounter}`;
    importedModels.push({
      id,
      name: file.name,
      sceneId: currentSceneId,
      root: container,
      parent,
    });
    renderImportedModelList();
    setImportedModelStatus(`Imported ${file.name} into ${currentSceneId} scene.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed.";
    const gltfHint =
      (file.name || "").toLowerCase().endsWith(".gltf")
        ? " If this .gltf references external .bin/textures, export/import as .glb instead."
        : "";
    setImportedModelStatus(`Import failed: ${message}.${gltfHint}`);
  } finally {
    if (importModelButton) {
      importModelButton.disabled = false;
    }
  }
}

function removeImportedModelById(id) {
  const index = importedModels.findIndex((entry) => entry.id === id);
  if (index < 0) {
    setImportedModelStatus("Select an imported model to remove.");
    return;
  }
  const [entry] = importedModels.splice(index, 1);
  entry.parent?.remove(entry.root);
  disposeObject3D(entry.root);
  renderImportedModelList();
  setImportedModelStatus(`Removed ${entry.name}.`);
}

function recordCommand(label, target, duration) {
  commandHistory.push({
    label,
    target: [...target],
    duration: Number(duration),
    stamp: Date.now(),
    source: "local-ui",
  });
  if (commandHistory.length > 24) {
    commandHistory = commandHistory.slice(-24);
  }
  renderCommandHistory();
}

function renderJointInputs(names) {
  jointForm.innerHTML = "";
  names.forEach((jointName, index) => {
    const wrapper = document.createElement("label");
    wrapper.className = "joint-field";
    wrapper.innerHTML = `
      <div class="joint-row">
        <span>${jointName}</span>
        <input data-role="slider" data-index="${index}" type="range" min="-180" max="180" step="1" value="0" ${sensorControlLocked ? "disabled" : ""}>
        <input data-role="number" data-index="${index}" type="number" min="-180" max="180" step="1" value="0" ${sensorControlLocked ? "disabled" : ""}>
      </div>
    `;
    jointForm.appendChild(wrapper);
  });

  jointForm.querySelectorAll('input[data-role="slider"]').forEach((input) => {
    input.addEventListener("input", onLiveJointInput);
  });
  jointForm.querySelectorAll('input[data-role="number"]').forEach((input) => {
    input.addEventListener("input", onLiveJointInput);
  });
}

function getJointValues() {
  return JOINT_NAMES.map((_, index) => {
    const input = jointForm.querySelector(`input[data-role="number"][data-index="${index}"]`);
    return degreesToRadians(input?.value ?? 0);
  });
}

function setJointValues(values) {
  JOINT_NAMES.forEach((_, index) => {
    const degrees = Math.round(radiansToDegrees(values[index] ?? 0));
    const numberInput = jointForm.querySelector(`input[data-role="number"][data-index="${index}"]`);
    const sliderInput = jointForm.querySelector(`input[data-role="slider"][data-index="${index}"]`);
    if (numberInput) {
      numberInput.value = String(degrees);
    }
    if (sliderInput) {
      sliderInput.value = String(degrees);
    }
  });
}

function getDisplayedPositions() {
  if (sensorBlend) {
    const progress = clamp((performance.now() - sensorBlend.startedAt) / sensorBlend.duration, 0, 1);
    localJointPositions = sensorBlend.start.map((start, index) => {
      const delta = shortestAngleDelta(start, sensorBlend.target[index]);
      return normalizeAngle(start + delta * progress);
    });
    if (progress >= 1) {
      sensorBlend = null;
    }
    return localJointPositions;
  }
  if (sensorControlLocked) {
    return localJointPositions;
  }
  if (backendConnected && Array.isArray(lastStatus?.joint_state?.positions)) {
    const now = performance.now();
    if (backendBlend) {
      const progress = clamp((now - backendBlend.startedAt) / backendBlend.duration, 0, 1);
      backendSmoothedPositions = backendBlend.start.map((start, index) => {
        const delta = shortestAngleDelta(start, backendBlend.target[index]);
        return normalizeAngle(start + delta * progress);
      });
      if (progress >= 1) {
        backendBlend = null;
      }
    }
    return backendSmoothedPositions;
  }
  return localJointPositions;
}

function hasFreshBackendState() {
  if (!backendConnected || !lastStatus?.joint_state?.positions || !lastStatus?.joint_state?.stamp) {
    return false;
  }
  const ageSec = Date.now() / 1000 - Number(lastStatus.joint_state.stamp);
  return Number.isFinite(ageSec) && ageSec >= 0 && ageSec < JOINT_STATE_FRESHNESS_SEC;
}

function setSyncStatus(tone, message) {
  syncStatus.className = `sync-status ${tone}`;
  syncStatus.textContent = message;
}

function setCalibrationCompletionMessage(tone, message) {
  if (!calibrationCompletionMessage) return;
  calibrationCompletionMessage.className = `sync-status ${tone}`;
  calibrationCompletionMessage.textContent = message;
}

function setSensorControlLocked(locked) {
  sensorControlLocked = Boolean(locked);
  if (!sensorControlLocked) calibrationCompletionSummary = "";
  const manualMotionControls = [
    presetDuration,
    customDuration,
    directDuration,
    directCommandInput,
    sendCustomButton,
    sendDirectButton,
    copyCurrentButton,
    syncRobotButton,
  ];
  manualMotionControls.forEach((element) => {
    if (element) element.disabled = sensorControlLocked;
  });
  jointForm.querySelectorAll("input, button, select").forEach((element) => {
    element.disabled = sensorControlLocked;
  });
  poseButtons.querySelectorAll("button").forEach((button) => {
    button.disabled = sensorControlLocked;
  });
  sequenceButtons.querySelectorAll("button").forEach((button) => {
    button.disabled = sensorControlLocked;
  });
  Object.values(calibrationTargetInputs).forEach((input) => {
    if (input) input.disabled = sensorControlLocked;
  });
  if (calibrationSourceSelect) calibrationSourceSelect.disabled = sensorControlLocked;
  if (calibrateCurrentButton) calibrateCurrentButton.disabled = sensorControlLocked;
  if (moveCalibrationPoseButton) moveCalibrationPoseButton.disabled = sensorControlLocked;
  if (clearLoadedCalibrationButton) clearLoadedCalibrationButton.disabled = sensorControlLocked;
  calibrationRows?.querySelectorAll(".calibration-load-toggle").forEach((checkbox) => {
    checkbox.disabled = sensorControlLocked;
  });
  if (finishCalibrationButton) {
    finishCalibrationButton.disabled = sensorControlLocked;
    finishCalibrationButton.textContent = sensorControlLocked
      ? "Sensor Control Locked"
      : "Complete Calibration";
  }
  if (uncalibrateCurrentButton) uncalibrateCurrentButton.disabled = !sensorControlLocked;
  if (sensorControlLocked) {
    activeMotion = null;
    backendBlend = null;
  }
}

function blockManualMotionWhileSensorLocked() {
  if (!sensorControlLocked) return false;
  setSyncStatus("sync-ok", "Sensor control is locked; unlock and recalibrate to use manual arm controls.");
  return true;
}

function renderPoseButtons(poses) {
  poseButtons.innerHTML = "";
  Object.keys(poses).forEach((poseName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = poseName;
    button.disabled = sensorControlLocked;
    button.addEventListener("click", async () => {
      if (blockManualMotionWhileSensorLocked()) return;
      const duration = Number(presetDuration.value || 1);
      setMotionTarget(poses[poseName], duration);
      updateArmKinematics(poses[poseName]);
      updateCollisionState();

      if (collisionState.active) {
        recordCommand(`${poseName}-blocked`, poses[poseName], duration);
        updateStatus({
          type: "blocked-by-collision-check",
          duration,
          target: poses[poseName],
        });
        return;
      }

      queueAutomaticCalibrationCapture(poses[poseName], duration, poseName);
      if (!collisionState.active) {
        try {
          await apiRequest("/api/pose", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pose: poseName, duration, source: "vite-ui" }),
          });
        } catch (_error) {
          backendConnected = false;
        }
      }
      recordCommand(poseName, poses[poseName], duration);
      await fetchStatus();
    });
    poseButtons.appendChild(button);
  });
}

function renderSequenceButtons() {
  sequenceButtons.innerHTML = "";
  const sequences = {
    "Deploy Cycle": [
      currentPredefinedPoses.home,
      currentPredefinedPoses.ready,
      currentPredefinedPoses.forward_low,
      currentPredefinedPoses.stretch_up,
      currentPredefinedPoses.home,
    ],
    "Inspection Sweep": [
      currentPredefinedPoses.ready,
      [0.6, -1.0, 0.0, -0.7, 0.0, 0.5, 0.0],
      [-0.6, -1.0, 0.0, -0.7, 0.0, -0.5, 0.0],
      currentPredefinedPoses.ready,
    ],
    "Fold And Extend": [
      currentPredefinedPoses.home,
      currentPredefinedPoses.forward_low,
      currentPredefinedPoses.home,
    ],
  };
  Object.entries(sequences).forEach(([label, sequence]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = sensorControlLocked;
    button.addEventListener("click", async () => {
      if (blockManualMotionWhileSensorLocked()) return;
      const duration = Number(directDuration.value || 1);
      for (const positions of sequence) {
        if (blockManualMotionWhileSensorLocked()) return;
        setJointValues(positions);
        setMotionTarget(positions, duration);
        updateArmKinematics(positions);
        updateCollisionState();
        if (collisionState.active) {
          recordCommand(`${label}-blocked`, positions, duration);
          updateStatus({
            type: "blocked-by-collision-check",
            duration,
            target: positions,
          });
          return;
        }
        queueAutomaticCalibrationCapture(positions, duration, label);
        try {
          await apiRequest("/api/joints", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ positions, duration, label, source: "vite-ui" }),
          });
        } catch (_error) {
          backendConnected = false;
        }
        recordCommand(label, positions, duration);
        await new Promise((resolve) => window.setTimeout(resolve, duration * 1000));
      }
      await fetchStatus();
    });
    sequenceButtons.appendChild(button);
  });
}

function updateStatus(lastCommand) {
  const positions = getDisplayedPositions();
  const backendStateMode = hasFreshBackendState()
    ? backendMode === "demo"
      ? "synthetic sensor state (demo)"
      : "live joint state"
    : "bridge only / local motion";

  if (!udpCalibrationSyncPinned) {
    if (backendMode === "demo") {
      setSyncStatus("sync-warn", "Demo mode: backend calls suppressed; using synthetic sensor data");
    } else if (hasFreshBackendState()) {
      setSyncStatus("sync-ok", "Live robot state available");
    } else if (backendConnected) {
      setSyncStatus("sync-warn", "Bridge connected but no live joint state");
    } else {
      setSyncStatus("sync-error", "Bridge unavailable");
    }
  }

  const backendLabel =
    backendMode === "demo"
      ? "demo mode (no network backend calls)"
      : backendConnected
        ? "connected"
        : "offline demo mode";
  const lastCallLabel = lastBackendCall
    ? `${lastBackendCall.method} ${lastBackendCall.path}${lastBackendCall.suppressed ? " (suppressed)" : ""}`
    : "none yet";

  statusOutput.textContent = [
    `Backend: ${backendLabel}`,
    `Backend endpoint: ${API_BASE_URL || "same-origin /api"}`,
    `Last backend call: ${lastCallLabel}`,
    `Backend state mode: ${backendStateMode}`,
    `Arm control source: ${sensorControlLocked ? "calibrated sensors (locked)" : "manual/backend"}`,
    `Rapier collision state: ${collisionState.active ? collisionState.messages.join(" | ") : "clear"}`,
    `Joint positions: ${formatPositions(positions)}`,
    `Last command type: ${lastCommand.type}`,
    `Last command duration: ${lastCommand.duration ?? "n/a"}`,
    `Last command target: ${
      Array.isArray(lastCommand.target) ? formatPositions(lastCommand.target) : "n/a"
    }`,
  ].join("\n");
}

function setSceneItemPresence(item, present) {
  sceneItems[item] = present;
  if (item === "arm" && armRoot) {
    armRoot.visible = present;
  } else if (item === "table" && tableMesh) {
    tableMesh.visible = present;
  } else if (item === "box" && boxMesh) {
    boxMesh.visible = present;
  } else if (item.startsWith("gantry-") && gantrySceneGroup) {
    const gantry = gantrySceneGroup.getObjectByName(item);
    if (gantry) {
      gantry.visible = present;
    }
  }
  renderItemStatus();
}

async function fetchStatus() {
  try {
    const status = await apiRequest("/api/status");
    backendConnected = true;
    backendMode = DEMO_NO_BACKEND ? "demo" : "live";
    lastStatus = status;
    if (Array.isArray(status.joint_state?.positions) && status.joint_state.positions.length === 7) {
      const incoming = status.joint_state.positions.map((value) => normalizeAngle(value));
      if (!backendSmoothingInitialized) {
        backendSmoothedPositions = [...incoming];
        backendSmoothingInitialized = true;
      }
      const distance = incoming.reduce(
        (sum, value, index) => sum + Math.abs(shortestAngleDelta(backendSmoothedPositions[index], value)),
        0
      );
      if (distance > 0.0005) {
        backendBlend = {
          start: [...backendSmoothedPositions],
          target: [...incoming],
          startedAt: performance.now(),
          duration: Math.max(80, STATUS_POLL_INTERVAL_MS),
        };
      }
    }
    if (Array.isArray(status.command_history)) {
      commandHistory = status.command_history.map((entry) => ({
        ...entry,
        stamp: (entry.stamp || 0) * 1000,
      }));
      renderCommandHistory();
    }
    if (status.predefined_poses) {
      const nextSignature = JSON.stringify(status.predefined_poses);
      if (nextSignature !== currentPresetSignature) {
        currentPredefinedPoses = status.predefined_poses;
        currentPresetSignature = nextSignature;
        renderPoseButtons(currentPredefinedPoses);
        renderSequenceButtons();
      }
    }
    if (!jointForm.children.length) {
      renderJointInputs(status.joint_state.names);
    }
    if (!poseButtons.children.length) {
      renderPoseButtons(currentPredefinedPoses);
    }
    if (!sequenceButtons.children.length) {
      renderSequenceButtons();
    }
    updateStatus(status.last_command);
  } catch (_error) {
    backendConnected = false;
    backendMode = "offline";
    backendBlend = null;
    if (!jointForm.children.length) {
      renderJointInputs(JOINT_NAMES);
    }
    if (!poseButtons.children.length) {
      renderPoseButtons(currentPredefinedPoses);
    }
    if (!sequenceButtons.children.length) {
      renderSequenceButtons();
    }
    updateStatus({
      type: "offline-demo",
      duration: activeMotion?.duration ?? null,
      target: targetJointPositions,
    });
  }
}

function setMotionTarget(positions, durationSec) {
  if (sensorControlLocked) {
    activeMotion = null;
    return false;
  }
  targetJointPositions = positions.map((value) => normalizeAngle(value));
  activeMotion = {
    start: localJointPositions.map((value) => normalizeAngle(value)),
    target: [...targetJointPositions],
    startedAt: performance.now(),
    duration: Math.max(0.2, Number(durationSec)) * 1000,
  };
  return true;
}

function onLiveJointInput(event) {
  if (blockManualMotionWhileSensorLocked()) {
    setJointValues(getDisplayedPositions());
    return;
  }
  const index = Number(event.target.dataset.index);
  const role = event.target.dataset.role;
  const value = Number(event.target.value);
  const peerRole = role === "slider" ? "number" : "slider";
  const peer = jointForm.querySelector(`input[data-role="${peerRole}"][data-index="${index}"]`);
  if (peer) {
    peer.value = String(value);
  }

  const positions = getJointValues();
  const duration = Number(customDuration.value || 1);
  setMotionTarget(positions, duration);
  updateArmKinematics(positions);
  updateCollisionState();
  if (!collisionState.active) {
    queueAutomaticCalibrationCapture(positions, duration, "joint-edit");
  }
  updateStatus({
    type: "live-joint-edit",
    duration,
    target: positions,
  });
}

function advanceOfflineMotion(now) {
  if (sensorControlLocked) {
    activeMotion = null;
    return;
  }
  if (backendConnected && Array.isArray(lastStatus?.joint_state?.positions)) {
    localJointPositions = [...lastStatus.joint_state.positions];
    return;
  }

  if (!activeMotion) {
    return;
  }

  const progress = clamp((now - activeMotion.startedAt) / activeMotion.duration, 0, 1);
  const eased = 1 - Math.pow(1 - progress, 3);
  localJointPositions = activeMotion.start.map((start, index) => {
    const delta = shortestAngleDelta(start, activeMotion.target[index]);
    return normalizeAngle(start + delta * eased);
  });

  if (progress >= 1) {
    activeMotion = null;
  }
}

function resizeRenderer() {
  if (useCanvasFallback) {
    const bounds = viewerCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(bounds.width * dpr));
    const height = Math.max(1, Math.floor(bounds.height * dpr));
    if (viewerCanvas.width !== width || viewerCanvas.height !== height) {
      viewerCanvas.width = width;
      viewerCanvas.height = height;
    }
    return;
  }

  if (!renderer || !camera) {
    return;
  }
  const bounds = viewerCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  if (viewerCanvas.width !== width || viewerCanvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function updateArmKinematics(positions) {
  if (!armRoot) {
    return;
  }
  linkStates.forEach((state, index) => {
    state.pivot.rotation.set(0, 0, 0);
    if (state.axis === "x") {
      state.pivot.rotation.x = positions[index] || 0;
    } else {
      state.pivot.rotation.z = positions[index] || 0;
    }
  });

  armRoot.updateMatrixWorld(true);

  linkStates.forEach((state, index) => {
    state.worldStart.setFromMatrixPosition(state.pivot.matrixWorld);
    state.worldEnd.copy(state.direction).applyMatrix4(state.pivot.matrixWorld);

    const center = state.worldStart.clone().lerp(state.worldEnd, 0.5);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(state.mesh.matrixWorld);

    rigidBodies[index].setNextKinematicTranslation(center);
    rigidBodies[index].setNextKinematicRotation({
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    });
  });
  updateAccelerometerVisualPositions();
}

function updateCollisionState() {
  if (!world) {
    return;
  }
  world.step();
  const messages = [];

  colliderHandles.forEach((handle, index) => {
    const touchesFloor = world.intersectionPair(handle, floorCollider.handle);
    const touchesTable = world.intersectionPair(handle, tableCollider.handle);

    if (touchesFloor) {
      messages.push(`Link ${index + 1} intersects the floor`);
    }
    if (touchesTable) {
      messages.push(`Link ${index + 1} intersects the table`);
    }
  });

  for (let i = 0; i < colliderHandles.length; i += 1) {
    for (let j = i + 2; j < colliderHandles.length; j += 1) {
      if (world.intersectionPair(colliderHandles[i], colliderHandles[j])) {
        messages.push(`Links ${i + 1} and ${j + 1} overlap`);
      }
    }
  }

  collisionState = {
    active: messages.length > 0,
    messages: [...new Set(messages)],
  };

  linkStates.forEach((state) => {
    state.mesh.material.color.setHex(collisionState.active ? 0xff7a59 : state.color);
  });
}

function ensureViewerNotice() {
  if (viewerNotice) {
    return viewerNotice;
  }
  viewerNotice = document.createElement("p");
  viewerNotice.className = "subtle";
  viewerNotice.style.marginBottom = "12px";
  viewerPanel.insertBefore(viewerNotice, viewerCanvas);
  return viewerNotice;
}

function updateViewerNotice() {
  const sceneLabel = currentSceneId === "gantry" ? "Gantry Cell" : "Arm Workcell";
  const mode = useCanvasFallback ? "2D canvas fallback mode" : `Three.js + Rapier mode (${webglMode})`;
  ensureViewerNotice().textContent = `${sceneLabel} · ${mode}`;
}

function applySceneVisibility() {
  if (armSceneGroup) {
    armSceneGroup.visible = currentSceneId === "arm";
  }
  if (gantrySceneGroup) {
    gantrySceneGroup.visible = currentSceneId === "gantry";
  }
  updateViewerNotice();
}

function resetFallbackCamera() {
  if (currentSceneId === "gantry") {
    fallbackCamera.yaw = 0.9;
    fallbackCamera.pitch = 0.46;
    fallbackCamera.distance = 10.2;
    fallbackCamera.target = { x: 0, y: 0, z: 0.85 };
    return;
  }
  fallbackCamera.yaw = 0.9;
  fallbackCamera.pitch = 0.55;
  fallbackCamera.distance = 2.4;
  fallbackCamera.target = { x: 0, y: 0, z: 0.45 };
}

function centerViewOnGantry(x, y) {
  const targetZ = 0.85;
  if (useCanvasFallback) {
    fallbackCamera.target = { x, y, z: targetZ };
    return;
  }
  if (!camera || !controls) {
    return;
  }
  const nextTarget = new THREE.Vector3(x, y, targetZ);
  const offset = camera.position.clone().sub(controls.target);
  camera.position.copy(nextTarget.clone().add(offset));
  controls.target.copy(nextTarget);
  controls.update();
}

function cycleGantryFocus() {
  if (currentSceneId !== "gantry") {
    currentSceneId = "gantry";
    sceneSelect.value = "gantry";
    applySceneVisibility();
    if (useCanvasFallback) {
      resetFallbackCamera();
    } else if (camera && controls) {
      const preset = CAMERA_PRESETS.gantry;
      camera.position.set(...preset.position);
      controls.target.set(...preset.target);
      controls.update();
    }
  }
  const focusCenters = [
    [SOURCE_GANTRY_CENTER.x, SOURCE_GANTRY_CENTER.y],
    ...DESTINATION_CENTERS,
  ];
  gantryFocusIndex = (gantryFocusIndex + 1) % focusCenters.length;
  const [focusX, focusY] = focusCenters[gantryFocusIndex];
  centerViewOnGantry(focusX, focusY);
}

function getActiveSceneGroup() {
  if (currentSceneId === "gantry") {
    return gantrySceneGroup || armSceneGroup || null;
  }
  return armSceneGroup || gantrySceneGroup || null;
}

function getActiveSceneBounds() {
  if (currentSceneId === "gantry") {
    const bounds = new THREE.Box3();
    const cellSpecs = getGantryCellSpecs();
    let anyVisible = false;
    cellSpecs.forEach(({ id, x, y, span }) => {
      if (!sceneItems[id]) return;
      anyVisible = true;
      const halfX = span.x * 0.5 + 0.3;
      const halfY = span.y * 0.5 + 0.3;
      bounds.expandByPoint(new THREE.Vector3(x - halfX, y - halfY, -0.05));
      bounds.expandByPoint(new THREE.Vector3(x + halfX, y + halfY, GANTRY_DIMS.topZ + 0.2));
    });

    if (anyVisible) {
      bounds.expandByPoint(
        new THREE.Vector3(-BELT_CROSS_HALF_SPAN - 0.5, BELT_TRUNK_BOTTOM_Y - 0.2, -0.05)
      );
      bounds.expandByPoint(
        new THREE.Vector3(BELT_CROSS_HALF_SPAN + 0.5, BELT_TRUNK_TOP_Y + 0.2, 1.0)
      );
      return bounds;
    }
  }

  const activeGroup = getActiveSceneGroup();
  if (activeGroup) {
    const groupBounds = new THREE.Box3().setFromObject(activeGroup);
    if (!groupBounds.isEmpty()) {
      return groupBounds;
    }
  }

  const fallbackBounds = new THREE.Box3();
  fallbackBounds.makeEmpty();
  const tableHalf = ENVIRONMENT.tableSize.clone().multiplyScalar(0.5);
  const tableMin = ENVIRONMENT.tableCenter.clone().sub(tableHalf);
  const tableMax = ENVIRONMENT.tableCenter.clone().add(tableHalf);
  fallbackBounds.expandByPoint(tableMin);
  fallbackBounds.expandByPoint(tableMax);
  fallbackBounds.expandByPoint(new THREE.Vector3(-1.15, -1.15, ENVIRONMENT.floorZ - 0.02));
  fallbackBounds.expandByPoint(new THREE.Vector3(1.15, 1.15, 1.55));

  return fallbackBounds.isEmpty() ? null : fallbackBounds;
}

function getBoxCorners(box) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function areCornersInsideCameraView(cameraObj, corners, ndcPadding = 0.02) {
  const minNdc = -1 + ndcPadding;
  const maxNdc = 1 - ndcPadding;
  cameraObj.updateMatrixWorld();
  for (let i = 0; i < corners.length; i += 1) {
    const ndc = corners[i].clone().project(cameraObj);
    if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)) {
      return false;
    }
    if (ndc.x < minNdc || ndc.x > maxNdc || ndc.y < minNdc || ndc.y > maxNdc) {
      return false;
    }
    if (ndc.z < -1 || ndc.z > 1) {
      return false;
    }
  }
  return true;
}

function computeFitDistanceFromCorners(corners, center, viewDir, upHint, tanHalfV, tanHalfH) {
  const forward = viewDir.clone().multiplyScalar(-1).normalize();
  const right = forward.clone().cross(upHint).normalize();
  const up = right.clone().cross(forward).normalize();
  let minDistance = 0.1;

  corners.forEach((corner) => {
    const rel = corner.clone().sub(center);
    const x = Math.abs(rel.dot(right));
    const y = Math.abs(rel.dot(up));
    const zOffset = rel.dot(viewDir);
    minDistance = Math.max(
      minDistance,
      x / Math.max(1e-5, tanHalfH) + zOffset,
      y / Math.max(1e-5, tanHalfV) + zOffset
    );
  });
  return minDistance;
}

function getDefaultViewDirection(sceneId) {
  const preset = CAMERA_PRESETS[sceneId] || CAMERA_PRESETS.arm;
  const presetPosition = new THREE.Vector3(...preset.position);
  const presetTarget = new THREE.Vector3(...preset.target);
  const viewDir = presetPosition.sub(presetTarget);
  if (viewDir.lengthSq() < 1e-8) {
    return new THREE.Vector3(1, 1, 0.8).normalize();
  }
  return viewDir.normalize();
}

function autoZoomOut() {
  const bounds = getActiveSceneBounds();
  if (!bounds) {
    return;
  }
  const center = bounds.getCenter(new THREE.Vector3());
  const corners = getBoxCorners(bounds);
  const fitBuffer = 1.015;
  const defaultViewDir = getDefaultViewDirection(currentSceneId);

  if (useCanvasFallback) {
    const width = Math.max(1, viewerCanvas.clientWidth || viewerCanvas.width || 1);
    const height = Math.max(1, viewerCanvas.clientHeight || viewerCanvas.height || 1);
    const focal = Math.min(width, height) * 0.99;
    const verticalFov = 2 * Math.atan((height * 0.5) / focal);
    const horizontalFov = 2 * Math.atan((width * 0.5) / focal);
    const tanHalfV = Math.tan(verticalFov * 0.5);
    const tanHalfH = Math.tan(horizontalFov * 0.5);
    const fitDistance = computeFitDistanceFromCorners(
      corners,
      center,
      defaultViewDir,
      new THREE.Vector3(0, 0, 1),
      tanHalfV,
      tanHalfH
    );
    const pitch = Math.asin(clamp(defaultViewDir.z, -1, 1));
    const yaw = Math.atan2(defaultViewDir.x, defaultViewDir.y);
    fallbackCamera.yaw = yaw;
    fallbackCamera.pitch = pitch;
    fallbackCamera.target = { x: center.x, y: center.y, z: center.z };
    fallbackCamera.distance = clamp(fitDistance * fitBuffer, 0.2, 100.0);
    return;
  }
  if (!camera || !controls) {
    return;
  }
  const verticalFov = THREE.MathUtils.degToRad(camera.fov || 50);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * camera.aspect);
  const tanHalfV = Math.tan(verticalFov * 0.5);
  const tanHalfH = Math.tan(horizontalFov * 0.5);
  const fitDistance = computeFitDistanceFromCorners(
    corners,
    center,
    defaultViewDir,
    camera.up.clone().normalize(),
    tanHalfV,
    tanHalfH
  );
  const distance = fitDistance * fitBuffer;
  controls.maxDistance = Math.max(controls.maxDistance || 0, distance * 1.6);
  controls.target.copy(center);
  camera.position.copy(center.clone().add(defaultViewDir.multiplyScalar(distance)));
  controls.update();

  let currentDistance = camera.position.distanceTo(center);
  for (let i = 0; i < 20; i += 1) {
    const viewDir = camera.position.clone().sub(center).normalize();
    const forward = viewDir.clone().multiplyScalar(-1);
    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = 0;
    corners.forEach((corner) => {
      const rel = corner.clone().sub(center);
      const depth = currentDistance + rel.dot(forward);
      minDepth = Math.min(minDepth, depth);
      maxDepth = Math.max(maxDepth, depth);
    });
    camera.near = Math.max(0.01, Math.min(0.1, minDepth * 0.5));
    camera.far = Math.max(50, maxDepth * 1.8);
    camera.updateProjectionMatrix();

    if (areCornersInsideCameraView(camera, corners, 0.025)) {
      break;
    }
    currentDistance *= 1.03;
    controls.maxDistance = Math.max(controls.maxDistance || 0, currentDistance * 1.4);
    camera.position.copy(center.clone().add(viewDir.multiplyScalar(currentDistance)));
    controls.update();
  }
}

function drawFallbackArm() {
  const ctx = fallbackContext;
  if (!ctx) {
    return;
  }

  resizeRenderer();
  ctx.clearRect(0, 0, viewerCanvas.width, viewerCanvas.height);

  const eye = new THREE.Vector3(
    fallbackCamera.target.x
      + fallbackCamera.distance * Math.cos(fallbackCamera.pitch) * Math.sin(fallbackCamera.yaw),
    fallbackCamera.target.y
      + fallbackCamera.distance * Math.cos(fallbackCamera.pitch) * Math.cos(fallbackCamera.yaw),
    fallbackCamera.target.z + fallbackCamera.distance * Math.sin(fallbackCamera.pitch)
  );
  const target = new THREE.Vector3(
    fallbackCamera.target.x,
    fallbackCamera.target.y,
    fallbackCamera.target.z
  );
  const forward = target.clone().sub(eye).normalize();
  const right = forward.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
  const up = right.clone().cross(forward).normalize();
  const focal = Math.min(viewerCanvas.width, viewerCanvas.height) * 0.95;

  const project = (point) => {
    const rel = point.clone().sub(eye);
    const xCam = rel.dot(right);
    const yCam = rel.dot(up);
    const zCam = rel.dot(forward);
    if (zCam <= 0.01) {
      return null;
    }
    return {
      x: viewerCanvas.width * 0.5 + (xCam / zCam) * focal,
      y: viewerCanvas.height * 0.52 - (yCam / zCam) * focal,
      depth: zCam,
    };
  };

  const drawLine3d = (a3, b3, color, width = 1) => {
    const a = project(a3);
    const b = project(b3);
    if (!a || !b) {
      return null;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    return { a, b };
  };

  const drawVectorArrow = (origin3d, end3d, color, thickness) => {
    const projected = drawLine3d(origin3d, end3d, color, thickness);
    if (!projected) return;
    const { a, b } = projected;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const screenLength = Math.hypot(dx, dy);
    if (screenLength < 1) return;
    const ux = dx / screenLength;
    const uy = dy / screenLength;
    const headLength = Math.min(screenLength * 0.45, 7 + thickness * 2.5);
    const headWidth = 3 + thickness * 1.7;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * headLength - uy * headWidth, b.y - uy * headLength + ux * headWidth);
    ctx.lineTo(b.x - ux * headLength + uy * headWidth, b.y - uy * headLength - ux * headWidth);
    ctx.closePath();
    ctx.fill();
  };

  for (let i = -6; i <= 6; i += 1) {
    drawLine3d(
      new THREE.Vector3(-0.9, i * 0.15, 0),
      new THREE.Vector3(0.9, i * 0.15, 0),
      "rgba(124, 209, 255, 0.12)"
    );
    drawLine3d(
      new THREE.Vector3(i * 0.15, -0.9, 0),
      new THREE.Vector3(i * 0.15, 0.9, 0),
      "rgba(124, 209, 255, 0.12)"
    );
  }

  const baseBottom = project(new THREE.Vector3(0, 0, 0));
  const baseTop = project(new THREE.Vector3(0, 0, 0.05));
  if (baseBottom && baseTop) {
    ctx.strokeStyle = "#253746";
    ctx.lineCap = "round";
    ctx.lineWidth = 42 * ((baseBottom.depth + baseTop.depth) * 0.5) ** -0.7;
    ctx.beginPath();
    ctx.moveTo(baseBottom.x, baseBottom.y);
    ctx.lineTo(baseTop.x, baseTop.y);
    ctx.stroke();
  }

  let transform = new THREE.Matrix4().identity();
  const jointTransforms = [];
  const positions = getDisplayedPositions();
  const segments = ARM_CONFIG.chain
    .map((joint, index) => {
      transform = transform.multiply(
        new THREE.Matrix4().makeTranslation(joint.offset[0], joint.offset[1], joint.offset[2])
      );
      jointTransforms[index] = transform.clone();
      transform = transform.multiply(
        joint.axis === "x"
          ? new THREE.Matrix4().makeRotationX(positions[index] || 0)
          : new THREE.Matrix4().makeRotationZ(positions[index] || 0)
      );

      const start = new THREE.Vector3(0, 0, 0).applyMatrix4(transform);
      const end = new THREE.Vector3(joint.drawTo[0], joint.drawTo[1], joint.drawTo[2]).applyMatrix4(
        transform
      );
      const start2d = project(start);
      const end2d = project(end);
      if (!start2d || !end2d) {
        return null;
      }
      return {
        start2d,
        end2d,
        radiusPx: Math.max(4.5, 16 - index * 1.35),
        sortDepth: (start2d.depth + end2d.depth) * 0.5,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.sortDepth - a.sortDepth);

  segments.forEach((segment, index) => {
    ctx.strokeStyle = collisionState.active ? "#ff7a59" : index % 2 === 0 ? "#d6ff57" : "#7cd1ff";
    ctx.lineCap = "round";
    ctx.lineWidth = segment.radiusPx * segment.sortDepth ** -0.72;
    ctx.beginPath();
    ctx.moveTo(segment.start2d.x, segment.start2d.y);
    ctx.lineTo(segment.end2d.x, segment.end2d.y);
    ctx.stroke();

    ctx.fillStyle = "#f5fbff";
    ctx.beginPath();
    ctx.arc(
      segment.start2d.x,
      segment.start2d.y,
      Math.max(2, 7 * segment.start2d.depth ** -0.7),
      0,
      Math.PI * 2
    );
    ctx.fill();
  });

  if (accelerometerVisualsVisible) {
    Object.entries(ACCELEROMETER_3D_CONFIG).forEach(([feedKey, config]) => {
      const reading = accelerometerReadings.get(feedKey);
      const jointTransform = jointTransforms[config.jointIndex];
      if (!reading || !jointTransform || Date.now() - reading.receivedAtMs >= 2000) return;

      const sensorTransform = jointTransform
        .clone()
        .multiply(new THREE.Matrix4().makeTranslation(...config.position))
        .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...config.rotation)));
      const origin = new THREE.Vector3().applyMatrix4(sensorTransform);
      const { x, y, z } = reading.acceleration;
      const components = [
        { value: x, axis: new THREE.Vector3(1, 0, 0), color: "#ff4d4d" },
        { value: y, axis: new THREE.Vector3(0, 1, 0), color: "#55dd77" },
        { value: z, axis: new THREE.Vector3(0, 0, 1), color: "#4da3ff" },
      ];
      components.forEach(({ value, axis, color }) => {
        const magnitude = Math.abs(value);
        if (magnitude < 0.005) return;
        const length = (0.018 + Math.min(2, magnitude) * 0.045) * accelerometerVectorScale;
        const localEnd = axis.multiplyScalar(value < 0 ? -length : length);
        const end = localEnd.applyMatrix4(sensorTransform);
        drawVectorArrow(origin, end, color, Math.max(1.25, accelerometerVectorScale * 2));
      });

      const resultant = new THREE.Vector3(x, y, z);
      const magnitude = resultant.length();
      if (magnitude >= 0.005) {
        const length = (0.025 + Math.min(2, magnitude) * 0.065) * accelerometerVectorScale;
        const end = resultant.normalize().multiplyScalar(length).applyMatrix4(sensorTransform);
        drawVectorArrow(origin, end, "#ffe45c", Math.max(1.5, accelerometerVectorScale * 2.5));
      }
    });
  }
}

function drawFallbackGantry() {
  const ctx = fallbackContext;
  if (!ctx) {
    return;
  }

  resizeRenderer();
  ctx.clearRect(0, 0, viewerCanvas.width, viewerCanvas.height);

  const eye = new THREE.Vector3(
    fallbackCamera.target.x
      + fallbackCamera.distance * Math.cos(fallbackCamera.pitch) * Math.sin(fallbackCamera.yaw),
    fallbackCamera.target.y
      + fallbackCamera.distance * Math.cos(fallbackCamera.pitch) * Math.cos(fallbackCamera.yaw),
    fallbackCamera.target.z + fallbackCamera.distance * Math.sin(fallbackCamera.pitch)
  );
  const target = new THREE.Vector3(
    fallbackCamera.target.x,
    fallbackCamera.target.y,
    fallbackCamera.target.z
  );
  const forward = target.clone().sub(eye).normalize();
  const right = forward.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
  const up = right.clone().cross(forward).normalize();
  const focal = Math.min(viewerCanvas.width, viewerCanvas.height) * 0.95;

  const project = (point) => {
    const rel = point.clone().sub(eye);
    const xCam = rel.dot(right);
    const yCam = rel.dot(up);
    const zCam = rel.dot(forward);
    if (zCam <= 0.01) {
      return null;
    }
    return {
      x: viewerCanvas.width * 0.5 + (xCam / zCam) * focal,
      y: viewerCanvas.height * 0.52 - (yCam / zCam) * focal,
      depth: zCam,
    };
  };

  const drawOps = [];
  const DRAW_LAYER = {
    ENV: 0,
    GANTRY: 1,
  };
  let activeLayer = DRAW_LAYER.ENV;
  const enqueueDraw = (depth, drawFn) => {
    if (Number.isFinite(depth)) {
      drawOps.push({ depth, drawFn, layer: activeLayer });
    }
  };
  const flushDrawOps = () => {
    drawOps.sort((a, b) => {
      if (a.layer !== b.layer) {
        return a.layer - b.layer;
      }
      return b.depth - a.depth;
    });
    drawOps.forEach((op) => op.drawFn());
  };

  const drawLine3d = (a3, b3, color, width = 1) => {
    const a = project(a3);
    const b = project(b3);
    if (!a || !b) {
      return;
    }
    const depth = (a.depth + b.depth) * 0.5;
    enqueueDraw(depth, () => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });
  };
  const drawPalletTop = (px, py, dims, fillColor, outlineColor, sideColor = "rgba(98, 66, 43, 0.9)") => {
    const halfX = dims.x * 0.5;
    const halfY = dims.y * 0.5;
    const topZ = dims.z;
    const corners3d = [
      new THREE.Vector3(px - halfX, py - halfY, topZ),
      new THREE.Vector3(px + halfX, py - halfY, topZ),
      new THREE.Vector3(px + halfX, py + halfY, topZ),
      new THREE.Vector3(px - halfX, py + halfY, topZ),
    ];
    const bottomCorners3d = [
      new THREE.Vector3(px - halfX, py - halfY, 0),
      new THREE.Vector3(px + halfX, py - halfY, 0),
      new THREE.Vector3(px + halfX, py + halfY, 0),
      new THREE.Vector3(px - halfX, py + halfY, 0),
    ];
    const corners2d = corners3d.map((corner) => project(corner));
    const bottomCorners2d = bottomCorners3d.map((corner) => project(corner));
    if (corners2d.some((corner) => !corner) || bottomCorners2d.some((corner) => !corner)) {
      return;
    }
    const [c0, c1, c2, c3] = corners2d;
    const [b0, b1, b2] = bottomCorners2d;
    const depth =
      (c0.depth + c1.depth + c2.depth + c3.depth + b0.depth + b1.depth + b2.depth) / 7;
    enqueueDraw(depth, () => {
      ctx.fillStyle = sideColor;
      ctx.beginPath();
      ctx.moveTo(c0.x, c0.y);
      ctx.lineTo(c1.x, c1.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.lineTo(b0.x, b0.y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(b1.x, b1.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.moveTo(c0.x, c0.y);
      ctx.lineTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.lineTo(c3.x, c3.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = outlineColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = "rgba(242, 208, 168, 0.6)";
      for (let slat = 1; slat <= 3; slat += 1) {
        const t = slat / 4;
        const sx0 = c0.x + (c3.x - c0.x) * t;
        const sy0 = c0.y + (c3.y - c0.y) * t;
        const sx1 = c1.x + (c2.x - c1.x) * t;
        const sy1 = c1.y + (c2.y - c1.y) * t;
        ctx.beginPath();
        ctx.moveTo(sx0, sy0);
        ctx.lineTo(sx1, sy1);
        ctx.stroke();
      }
    });
  };

  for (let i = -6; i <= 6; i += 1) {
    drawLine3d(
      new THREE.Vector3(-1.2, i * 0.2, 0),
      new THREE.Vector3(1.2, i * 0.2, 0),
      "rgba(124, 209, 255, 0.1)"
    );
    drawLine3d(
      new THREE.Vector3(i * 0.2, -0.8, 0),
      new THREE.Vector3(i * 0.2, 0.8, 0),
      "rgba(124, 209, 255, 0.1)"
    );
  }

  const gantryCells = getGantryCellSpecs();
  const sourceCell = gantryCells[0];
  const sourceTopRailLength = Math.max(0.5, sourceCell.span.x - GANTRY_DIMS.uprightSize * 0.35);
  const sourceBridgeBeamLength = Math.max(0.45, sourceTopRailLength - 0.18);
  const sourceTravelX = Math.max(
    0.25,
    sourceBridgeBeamLength * 0.5 - GANTRY_DIMS.carriageSize.x * 0.55
  );
  const sourceTravelY = Math.max(
    0.15,
    sourceCell.span.y * 0.5 - GANTRY_DIMS.carriageSize.y * 0.9
  );
  const fallbackTime = performance.now() * 0.001;
  const positions = getDisplayedPositions();
  const carriageX = clamp((positions[0] || 0) / 1.57, -1, 1) * sourceTravelX;
  const bridgeY = clamp((positions[1] || 0) / 1.57, -1, 1) * sourceTravelY;
  const hookZ = -0.15 + clamp(((positions[2] || 0) + 1.57) / 3.14, 0, 1) * 0.75;
  const conveyorStrips = [
    // Sketch layout: center trunk with two horizontal cross belts.
    { start: new THREE.Vector3(0.0, BELT_TRUNK_TOP_Y, FACILITY_BELT_Z), end: new THREE.Vector3(0.0, BELT_TRUNK_BOTTOM_Y, FACILITY_BELT_Z) },
    {
      start: new THREE.Vector3(-BELT_CROSS_HALF_SPAN, SOURCE_OFFLOAD_Y, FACILITY_BELT_Z),
      end: new THREE.Vector3(BELT_CROSS_HALF_SPAN, SOURCE_OFFLOAD_Y, FACILITY_BELT_Z),
    },
    {
      start: new THREE.Vector3(-BELT_CROSS_HALF_SPAN, LOWER_CROSS_BELT_Y, FACILITY_BELT_Z),
      end: new THREE.Vector3(BELT_CROSS_HALF_SPAN, LOWER_CROSS_BELT_Y, FACILITY_BELT_Z),
    },
  ];

  const drawGantryFrame = ({ x: cx, y: cy, span, dynamic = false, rotationRad = 0 }) => {
    const prevLayer = activeLayer;
    activeLayer = DRAW_LAYER.GANTRY;

    const cosR = Math.cos(rotationRad);
    const sinR = Math.sin(rotationRad);
    const pLocal = (lx, ly, lz) =>
      new THREE.Vector3(cx + lx * cosR - ly * sinR, cy + lx * sinR + ly * cosR, lz);
    const halfSpanX = span.x * 0.5;
    const halfSpanY = span.y * 0.5;
    const pillarX = Math.max(0.25, halfSpanX - GANTRY_DIMS.uprightSize * 0.5);
    const pillarY = Math.max(0.2, halfSpanY - GANTRY_DIMS.uprightSize * 0.5);
    const topRailLength = Math.max(0.5, span.x - GANTRY_DIMS.uprightSize * 0.35);
    const runwayLength = Math.max(0.5, span.y - GANTRY_DIMS.uprightSize * 0.35);
    const bridgeBeamLength = Math.max(0.45, topRailLength - 0.18);
    const localTravelX = Math.max(
      0.25,
      bridgeBeamLength * 0.5 - GANTRY_DIMS.carriageSize.x * 0.55
    );
    const corners = [
      pLocal(-pillarX, -pillarY, 0),
      pLocal(-pillarX, pillarY, 0),
      pLocal(pillarX, -pillarY, 0),
      pLocal(pillarX, pillarY, 0),
    ];
    corners.forEach((p) => {
      drawLine3d(p, new THREE.Vector3(p.x, p.y, GANTRY_DIMS.topZ), "#7cd1ff", 10);
    });
    // End ties across the portal frame.
    drawLine3d(
      pLocal(-topRailLength * 0.5, -pillarY, GANTRY_DIMS.topZ),
      pLocal(topRailLength * 0.5, -pillarY, GANTRY_DIMS.topZ),
      "#7cd1ff",
      10
    );
    drawLine3d(
      pLocal(-topRailLength * 0.5, pillarY, GANTRY_DIMS.topZ),
      pLocal(topRailLength * 0.5, pillarY, GANTRY_DIMS.topZ),
      "#7cd1ff",
      10
    );
    // Side runway beams where the bridge rides.
    drawLine3d(
      pLocal(-pillarX, -runwayLength * 0.5, GANTRY_DIMS.topZ),
      pLocal(-pillarX, runwayLength * 0.5, GANTRY_DIMS.topZ),
      "#91d8f4",
      9
    );
    drawLine3d(
      pLocal(pillarX, -runwayLength * 0.5, GANTRY_DIMS.topZ),
      pLocal(pillarX, runwayLength * 0.5, GANTRY_DIMS.topZ),
      "#91d8f4",
      9
    );
    // Cross-bracing on both side frames.
    const braceZLow = 0.18;
    const braceZHigh = GANTRY_DIMS.topZ - 0.08;
    drawLine3d(
      pLocal(-pillarX, -pillarY, braceZLow),
      pLocal(-pillarX, pillarY, braceZHigh),
      "#6aaeca",
      4
    );
    drawLine3d(
      pLocal(-pillarX, pillarY, braceZLow),
      pLocal(-pillarX, -pillarY, braceZHigh),
      "#6aaeca",
      4
    );
    drawLine3d(
      pLocal(pillarX, -pillarY, braceZLow),
      pLocal(pillarX, pillarY, braceZHigh),
      "#6aaeca",
      4
    );
    drawLine3d(
      pLocal(pillarX, pillarY, braceZLow),
      pLocal(pillarX, -pillarY, braceZHigh),
      "#6aaeca",
      4
    );

    const bridgeYLocal = dynamic ? bridgeY : 0;
    drawLine3d(
      pLocal(-localTravelX, bridgeYLocal, GANTRY_DIMS.bridgeZ),
      pLocal(localTravelX, bridgeYLocal, GANTRY_DIMS.bridgeZ),
      "#d6ff57",
      11
    );
    const armCount = GANTRY_ARM_CONFIG.count;
    const armTrackHalf = Math.max(
      0.45,
      bridgeBeamLength * 0.45 * GANTRY_ARM_CONFIG.runnerUtilization
    );
    const laneInset = 0.04;
    const laneSpan = Math.max(0.02, GANTRY_DIMS.bridgeRunnerWidth - laneInset * 2);
    const lanePitch = armCount > 1 ? laneSpan / (armCount - 1) : 0;
    for (let laneIndex = 0; laneIndex < armCount; laneIndex += 1) {
      const laneY = -laneSpan * 0.5 + lanePitch * laneIndex;
      drawLine3d(
        pLocal(-localTravelX * 0.96, bridgeYLocal + laneY, GANTRY_DIMS.bridgeZ + 0.07),
        pLocal(localTravelX * 0.96, bridgeYLocal + laneY, GANTRY_DIMS.bridgeZ + 0.07),
        "#9ab923",
        2
      );
    }
    for (let armIndex = 0; armIndex < armCount; armIndex += 1) {
      const lane = armCount > 1 ? armIndex / (armCount - 1) : 0.5;
      const laneY = -laneSpan * 0.5 + lanePitch * armIndex;
      const armXLocal = -armTrackHalf + lane * (armTrackHalf * 2);
      const drop = GANTRY_ARM_CONFIG.idleDrop;
      const armTop = pLocal(armXLocal, bridgeYLocal + laneY, GANTRY_DIMS.bridgeZ - 0.02);
      const armBottom = pLocal(armXLocal, bridgeYLocal + laneY, GANTRY_DIMS.bridgeZ - drop);
      drawLine3d(armTop, armBottom, "#bcc9d2", 3);
      const toolPoint = project(armBottom);
      if (toolPoint) {
        enqueueDraw(toolPoint.depth, () => {
          ctx.fillStyle = "#ffb366";
          const toolR = Math.max(1.8, 3.5 * toolPoint.depth ** -0.7);
          ctx.beginPath();
          ctx.arc(toolPoint.x, toolPoint.y, toolR, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
    // End trucks at beam tips.
    drawLine3d(
      pLocal(-localTravelX, bridgeYLocal, GANTRY_DIMS.bridgeZ + 0.08),
      pLocal(-localTravelX, bridgeYLocal, GANTRY_DIMS.bridgeZ - 0.08),
      "#f5fbff",
      6
    );
    drawLine3d(
      pLocal(localTravelX, bridgeYLocal, GANTRY_DIMS.bridgeZ + 0.08),
      pLocal(localTravelX, bridgeYLocal, GANTRY_DIMS.bridgeZ - 0.08),
      "#f5fbff",
      6
    );
    if (dynamic) {
      drawLine3d(
        pLocal(carriageX, bridgeY, GANTRY_DIMS.bridgeZ),
        pLocal(carriageX, bridgeY, hookZ),
        "#ffb366",
        6
      );
      const gripperXY = pLocal(carriageX, bridgeY, 0);
      const isCupContact =
        Math.abs(gripperXY.x - getSourcePickupCenter().x) < 0.12 &&
        Math.abs(gripperXY.y - getSourcePickupCenter().y) < 0.12 &&
        Math.abs(hookZ - -0.08) < 0.1;
      const carriagePoint = project(
        pLocal(carriageX, bridgeY, GANTRY_DIMS.bridgeZ)
      );
      if (carriagePoint) {
        enqueueDraw(carriagePoint.depth, () => {
          ctx.fillStyle = "#f5fbff";
          ctx.fillRect(carriagePoint.x - 11, carriagePoint.y - 8, 22, 16);
        });
      }
      const gripperPoint = project(pLocal(carriageX, bridgeY, hookZ));
      if (gripperPoint) {
        enqueueDraw(gripperPoint.depth, () => {
          ctx.fillStyle = isCupContact ? "#8ff3d1" : "#6c7f8c";
          const cupSize = 3.5;
          ctx.beginPath();
          ctx.arc(gripperPoint.x - 6, gripperPoint.y - 2, cupSize, 0, Math.PI * 2);
          ctx.arc(gripperPoint.x + 6, gripperPoint.y - 2, cupSize, 0, Math.PI * 2);
          ctx.arc(gripperPoint.x - 6, gripperPoint.y + 4, cupSize, 0, Math.PI * 2);
          ctx.arc(gripperPoint.x + 6, gripperPoint.y + 4, cupSize, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    activeLayer = prevLayer;
  };

  drawGantryFrame(gantryCells[0]);
  gantryCells.slice(1).forEach((cell) => drawGantryFrame(cell));

  conveyorStrips.forEach(({ start, end }) => {
    const tangent = end.clone().sub(start);
    const length = tangent.length();
    if (length < 0.02) {
      return;
    }
    tangent.normalize();
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    const width = FACILITY_BELT_WIDTH;
    const railOffset = normal.clone().multiplyScalar(width * 0.5);
    drawLine3d(start.clone().add(railOffset), end.clone().add(railOffset), "#2d404c", 3);
    drawLine3d(start.clone().sub(railOffset), end.clone().sub(railOffset), "#2d404c", 3);

    const rollerCount = Math.max(6, Math.floor(length / 0.08));
    const rollerSpacing = length / rollerCount;
    for (let i = 0; i <= rollerCount; i += 1) {
      const center = start.clone().add(tangent.clone().multiplyScalar(i * rollerSpacing));
      drawLine3d(
        center.clone().add(normal.clone().multiplyScalar(width * 0.43)),
        center.clone().sub(normal.clone().multiplyScalar(width * 0.43)),
        "#aab5bf",
        2
      );
    }
  });

  // Source gantry feed area: 24 pallets (12/side, 2x6 per side).
  getSourcePalletSlots(SOURCE_STACK_CENTER.x, SOURCE_STACK_CENTER.y).forEach(([px, py]) => {
    drawPalletTop(px, py, SOURCE_PALLET_DIMS, "#9b6a43", "#c38a59");
  });
  const supplyBoxes = getSourceBoxPositions();
  supplyBoxes.forEach(([x, y, z]) => {
    const p = project(new THREE.Vector3(x, y, z));
    if (p) {
      enqueueDraw(p.depth, () => {
        const sz = Math.max(5, 11 * p.depth ** -0.6);
        ctx.fillStyle = "#c9895d";
        ctx.fillRect(p.x - sz * 0.5, p.y - sz * 0.5, sz, sz);
      });
    }
  });

  // Destination stations: 12 pallets per side (4x3), split around belt centerline.
  DESTINATION_CENTERS.forEach(([cx, cy], idx) => {
    const fillColor = idx % 2 === 0 ? "#9b6a43" : "#8e5f3b";
    const outlineColor = idx % 2 === 0 ? "#c38a59" : "#b97a4a";
    getDestinationPalletSlots(cx, cy).forEach(([px, py]) => {
      drawPalletTop(px, py, DESTINATION_PALLET_DIMS, fillColor, outlineColor);
    });
  });

  flushDrawOps();
}

function animate(now) {
  resizeRenderer();
  advanceOfflineMotion(now);

  if (useCanvasFallback) {
    if (currentSceneId === "gantry") {
      drawFallbackGantry();
    } else {
      drawFallbackArm();
    }
    requestAnimationFrame(animate);
    return;
  }

  resetGantryArmSystems(gantryArmSystems);

  const positions = getDisplayedPositions();
  updateArmKinematics(positions);
  if (gantryBridge && gantryCarriage && gantryHook) {
    gantryCarriage.position.x = clamp((positions[0] || 0) / 1.57, -1, 1) * gantryTravelX;
    gantryBridge.position.y = clamp((positions[1] || 0) / 1.57, -1, 1) * gantryTravelY;
    gantryHook.position.z = -0.15 + clamp(((positions[2] || 0) + 1.57) / 3.14, 0, 1) * 0.75;

    let hasContact = false;
    if (gantryGripperPad) {
      const padWorld = gantryGripperPad.getWorldPosition(new THREE.Vector3());

      if (!gantryAttachedSourceBox) {
        const bestCandidate = findAttachableSourceBox(sourceBoxMeshes, padWorld);
        if (bestCandidate) {
          gantryAttachedSourceBox = bestCandidate;
          hasContact = true;
        }
      }

      if (gantryAttachedSourceBox) {
        const localPad = gantrySceneGroup.worldToLocal(padWorld.clone());
        gantryAttachedSourceBox.position.set(localPad.x, localPad.y, localPad.z - BOX_DIMS.z * 0.5);
        hasContact = true;
      }
    }

    gantryGripperCups.forEach((cup) => {
      cup.material.color.setHex(hasContact ? 0x8ff3d1 : 0x6c7f8c);
    });
  }
  updateCollisionState();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

sendCustomButton.addEventListener("click", async () => {
  if (blockManualMotionWhileSensorLocked()) return;
  const positions = getJointValues().map((value) => normalizeAngle(value));
  const duration = Number(customDuration.value || 1);
  setMotionTarget(positions, duration);
  updateArmKinematics(positions);
  updateCollisionState();

  if (collisionState.active) {
    recordCommand("custom-blocked", positions, duration);
    updateStatus({
      type: "blocked-by-collision-check",
      duration,
      target: positions,
    });
    return;
  }

  queueAutomaticCalibrationCapture(positions, duration, "custom");
  try {
    await apiRequest("/api/joints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions, duration, label: "custom", source: "vite-ui" }),
    });
  } catch (_error) {
    backendConnected = false;
  }
  recordCommand("custom", positions, duration);
  await fetchStatus();
});

sendDirectButton.addEventListener("click", async () => {
  if (blockManualMotionWhileSensorLocked()) return;
  const duration = Number(directDuration.value || 1);
  const commandSets = directCommandInput.value
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (!commandSets.length) {
    updateStatus({
      type: "invalid-direct-command",
      duration: null,
      target: null,
    });
    return;
  }

  for (const commandSet of commandSets) {
    if (blockManualMotionWhileSensorLocked()) return;
    const values = commandSet
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (values.length !== 7) {
      updateStatus({
        type: "invalid-direct-command",
        duration: null,
        target: null,
      });
      return;
    }

    const positions = values.map((value) => degreesToRadians(value));
    setJointValues(positions);
    setMotionTarget(positions, duration);
    updateArmKinematics(positions);
    updateCollisionState();

    if (collisionState.active) {
      recordCommand("direct-blocked", positions, duration);
      updateStatus({
        type: "blocked-by-collision-check",
        duration,
        target: positions,
      });
      return;
    }

    queueAutomaticCalibrationCapture(positions, duration, "direct");
    try {
      await apiRequest("/api/joints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions, duration, label: "direct", source: "vite-ui" }),
      });
    } catch (_error) {
      backendConnected = false;
    }

    recordCommand("direct", positions, duration);
    await new Promise((resolve) => window.setTimeout(resolve, duration * 1000));
  }

  await fetchStatus();
});

copyCurrentButton.addEventListener("click", () => {
  if (blockManualMotionWhileSensorLocked()) return;
  setJointValues(getDisplayedPositions());
});

refreshButton.addEventListener("click", fetchStatus);

syncRobotButton.addEventListener("click", () => {
  if (blockManualMotionWhileSensorLocked()) return;
  if (hasFreshBackendState()) {
    const positions = [...lastStatus.joint_state.positions];
    localJointPositions = [...positions];
    targetJointPositions = [...positions];
    activeMotion = null;
    setJointValues(positions);
    updateArmKinematics(positions);
    updateCollisionState();
    if (backendMode === "demo") {
      setSyncStatus("sync-warn", "Synced from simulated demo sensor state");
    } else {
      setSyncStatus("sync-ok", "Synced from live robot state");
    }
    updateStatus({
      type: "synced-from-robot",
      duration: null,
      target: positions,
    });
    return;
  }

  if (backendMode === "demo") {
    setSyncStatus("sync-warn", "Demo mode active: sync uses simulated state.");
  } else if (backendConnected) {
    setSyncStatus("sync-warn", "Cannot sync: no live joint state. Start Gazebo/controllers.");
  } else {
    setSyncStatus("sync-error", "Cannot sync: ROS bridge is unavailable.");
  }
});

resetCameraButton.addEventListener("click", () => {
  if (useCanvasFallback) {
    resetFallbackCamera();
    return;
  }
  if (!camera || !controls) {
    return;
  }
  const preset = CAMERA_PRESETS[currentSceneId] || CAMERA_PRESETS.arm;
  camera.position.set(...preset.position);
  controls.target.set(...preset.target);
  controls.update();
});

cycleGantryFocusButton?.addEventListener("click", cycleGantryFocus);
autoZoomOutButton?.addEventListener("click", autoZoomOut);
toggleAccelerometerVectorsButton?.addEventListener("click", () => {
  setAccelerometerVisualsVisible(!accelerometerVisualsVisible);
});
accelerometerVectorScaleInput?.addEventListener("input", (event) => {
  const nextScale = Number(event.target.value);
  if (!Number.isFinite(nextScale)) return;
  accelerometerVectorScale = nextScale;
  if (accelerometerVectorScaleValue) {
    accelerometerVectorScaleValue.value = `${nextScale.toFixed(1)}×`;
  }
  accelerometerVisuals.forEach(applyAccelerometerVectorDimensions);
});
calibrateCurrentButton?.addEventListener("click", captureCalibrationRow);
moveCalibrationPoseButton?.addEventListener("click", moveToCalibrationOrientation);
finishCalibrationButton?.addEventListener("click", finishCalibrationSession);
uncalibrateCurrentButton?.addEventListener("click", uncalibrateCurrentPose);
clearLoadedCalibrationButton?.addEventListener("click", clearLoadedCalibrationRows);
calibrationSourceSelect?.addEventListener("change", () => {
  preCalibrationActive = true;
  sensorBlend = null;
  setSensorControlLocked(false);
  calibratedReferenceId = null;
  calibratedUdpReferenceAngles = null;
  calibratedSensorModels = null;
  lastAppliedUdpAngles = null;
  udpCalibrationSyncPinned = false;
  fetchCalibrationStatus();
  connectCalibrationStream();
});

clearCommandsButton.addEventListener("click", () => {
  commandHistory = [];
  renderCommandHistory();
});

if (importModelButton && importModelFileInput) {
  importModelButton.addEventListener("click", () => {
    importModelFileInput.value = "";
    importModelFileInput.click();
  });

  importModelFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    await handleImportModelFile(file);
  });
}

if (removeImportedModelButton && importedModelSelect) {
  removeImportedModelButton.addEventListener("click", () => {
    removeImportedModelById(importedModelSelect.value);
  });
}

viewerCanvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

viewerCanvas.addEventListener("mousedown", (event) => {
  if (!useCanvasFallback) {
    return;
  }
  fallbackPointer.dragging = true;
  fallbackPointer.mode = event.button === 2 || event.shiftKey || event.ctrlKey ? "pan" : "orbit";
  fallbackPointer.x = event.clientX;
  fallbackPointer.y = event.clientY;
});

window.addEventListener("mouseup", () => {
  fallbackPointer.dragging = false;
});

window.addEventListener("mousemove", (event) => {
  if (!useCanvasFallback || !fallbackPointer.dragging) {
    return;
  }

  const dx = event.clientX - fallbackPointer.x;
  const dy = event.clientY - fallbackPointer.y;
  fallbackPointer.x = event.clientX;
  fallbackPointer.y = event.clientY;

  if (fallbackPointer.mode === "pan") {
    const panScale = fallbackCamera.distance * 0.0015;
    // Pan on the ground plane: horizontal drag maps to local right/left,
    // vertical drag maps to local forward/back (XY only, no Z drift).
    const rightX = Math.cos(fallbackCamera.yaw);
    const rightY = -Math.sin(fallbackCamera.yaw);
    const forwardX = -Math.sin(fallbackCamera.yaw);
    const forwardY = -Math.cos(fallbackCamera.yaw);
    fallbackCamera.target.x += dx * panScale * rightX - dy * panScale * forwardX;
    fallbackCamera.target.y += dx * panScale * rightY - dy * panScale * forwardY;
  } else {
    fallbackCamera.yaw -= dx * 0.008;
    fallbackCamera.pitch = clamp(fallbackCamera.pitch + dy * 0.008, -1.35, 1.35);
  }
});

window.addEventListener("keydown", (event) => {
  if (!controls || useCanvasFallback) {
    return;
  }
  if (event.key === "Control") {
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  }
});

window.addEventListener("keyup", (event) => {
  if (!controls || useCanvasFallback) {
    return;
  }
  if (event.key === "Control") {
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  }
});

window.addEventListener("blur", () => {
  if (!controls || useCanvasFallback) {
    return;
  }
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
});

viewerCanvas.addEventListener(
  "wheel",
  (event) => {
    if (!useCanvasFallback) {
      return;
    }
    event.preventDefault();
    fallbackCamera.distance = clamp(
      fallbackCamera.distance * (1 + event.deltaY * 0.001),
      0.2,
      20.0
    );
  },
  { passive: false }
);

window.addEventListener("resize", resizeRenderer);

function initializeCanvasFallback() {
  fallbackContext = viewerCanvas.getContext("2d");
  if (!fallbackContext) {
    throw new Error("Canvas 2D context unavailable");
  }
  useCanvasFallback = true;
  webglMode = "canvas-fallback";
  renderer = null;
  camera = null;
  controls = null;
  scene = null;
  armSceneGroup = null;
  gantrySceneGroup = null;
  armRoot = null;
  linkStates = [];
  resetFallbackCamera();
  resizeRenderer();
  updateViewerNotice();
}

function initializeScene() {
  const contextAttributes = {
    alpha: true,
    antialias: false,
    depth: true,
    stencil: false,
    powerPreference: "low-power",
    premultipliedAlpha: false,
  };
  const gl =
    viewerCanvas.getContext("webgl2", contextAttributes) ||
    viewerCanvas.getContext("webgl", contextAttributes) ||
    viewerCanvas.getContext("experimental-webgl", contextAttributes);

  if (!gl) {
    throw new Error("WebGL context unavailable");
  }

  webglMode =
    typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
      ? "webgl2"
      : "webgl1";
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1419);

  renderer = new THREE.WebGLRenderer({
    canvas: viewerCanvas,
    context: gl,
    antialias: false,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = false;

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
  camera.up.set(0, 0, 1);
  const initialPreset = CAMERA_PRESETS[currentSceneId] || CAMERA_PRESETS.arm;
  camera.position.set(...initialPreset.position);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...initialPreset.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.enableZoom = true;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = -1.0;
  controls.rotateSpeed = 0.95;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
  controls.minDistance = 0.15;
  controls.maxDistance = 25;
  controls.maxPolarAngle = Math.PI * 0.48;

  scene.add(new THREE.HemisphereLight(0xf5fbff, 0x0b1014, 1.0));

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
  keyLight.position.set(2.6, 1.8, 3.4);
  scene.add(keyLight);

  const fillLight = new THREE.PointLight(0x7cd1ff, 20, 8);
  fillLight.position.set(-1.6, -1.6, 1.8);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(2.4, 16, 0x7cd1ff, 0x26404f);
  grid.rotation.x = Math.PI / 2;
  grid.material.opacity = 0.3;
  grid.material.transparent = true;
  scene.add(grid);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 64),
    new THREE.MeshLambertMaterial({
      color: 0x121b23,
    })
  );
  scene.add(floor);

  armSceneGroup = new THREE.Group();
  gantrySceneGroup = new THREE.Group();
  scene.add(armSceneGroup);
  scene.add(gantrySceneGroup);

  const table = new THREE.Mesh(
    new THREE.BoxGeometry(ENVIRONMENT.tableSize.x, ENVIRONMENT.tableSize.y, ENVIRONMENT.tableSize.z),
    new THREE.MeshLambertMaterial({
      color: 0x6a3f22,
    })
  );
  table.position.copy(ENVIRONMENT.tableCenter);
  armSceneGroup.add(table);
  tableMesh = table;
  tableMesh.visible = sceneItems.table;

  boxMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.12, 0.12),
    new THREE.MeshLambertMaterial({ color: 0xffa45d })
  );
  boxMesh.position.set(0.38, 0, ENVIRONMENT.tableCenter.z + ENVIRONMENT.tableSize.z / 2 + 0.06);
  armSceneGroup.add(boxMesh);
  boxMesh.visible = sceneItems.box;

  const armBlackMaterial = new THREE.MeshStandardMaterial({
    color: 0x171b20,
    metalness: 0.72,
    roughness: 0.34,
  });
  const armEdgeMaterial = new THREE.MeshStandardMaterial({
    color: 0x343b43,
    metalness: 0.82,
    roughness: 0.25,
  });
  const armSilverMaterial = new THREE.MeshStandardMaterial({
    color: 0xc5ccd2,
    metalness: 0.9,
    roughness: 0.2,
  });
  const armServoMaterial = new THREE.MeshStandardMaterial({
    color: 0x245d82,
    metalness: 0.55,
    roughness: 0.28,
  });
  const armServoLabelMaterial = new THREE.MeshStandardMaterial({
    color: 0x88b9d1,
    metalness: 0.35,
    roughness: 0.38,
  });

  const baseFoot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.125, 0.14, 0.024, 8),
    armBlackMaterial
  );
  baseFoot.position.z = 0.012;
  armSceneGroup.add(baseFoot);

  const basePlate = new THREE.Mesh(
    new THREE.CylinderGeometry(0.105, 0.105, 0.022, 32),
    armEdgeMaterial
  );
  basePlate.position.z = 0.035;
  armSceneGroup.add(basePlate);

  const baseTurntable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.077, 0.09, 0.05, 32),
    armServoMaterial
  );
  baseTurntable.position.z = 0.068;
  armSceneGroup.add(baseTurntable);

  for (let index = 0; index < 4; index += 1) {
    const bolt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, 0.004, 16),
      armSilverMaterial
    );
    const angle = index * Math.PI * 0.5 + Math.PI * 0.25;
    bolt.position.set(Math.cos(angle) * 0.105, Math.sin(angle) * 0.105, 0.026);
    armSceneGroup.add(bolt);
  }

  armSceneGroup.add(new THREE.AxesHelper(0.22));

  armRoot = new THREE.Group();
  armSceneGroup.add(armRoot);

  linkStates = [];
  let parentGroup = armRoot;
  ARM_CONFIG.chain.forEach((joint, jointIndex) => {
    const pivot = new THREE.Group();
    pivot.position.set(...joint.offset);
    parentGroup.add(pivot);

    const direction = new THREE.Vector3(...joint.drawTo);
    const length = direction.length();
    const geometry = new THREE.CapsuleGeometry(
      joint.radius,
      Math.max(0.001, length - joint.radius * 2),
      10,
      20
    );
    const material = new THREE.MeshStandardMaterial({
      color: 0x252b31,
      metalness: 0.65,
      roughness: 0.32,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(direction.clone().multiplyScalar(0.5));
    mesh.quaternion.copy(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        direction.clone().normalize()
      )
    );
    mesh.scale.set(0.68, 1, 0.68);
    pivot.add(mesh);

    const linkOrientation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction.clone().normalize()
    );
    const railWidth = Math.max(0.014, joint.radius * 0.55);
    const railDepth = Math.max(0.012, joint.radius * 0.42);
    const railOffset = Math.max(0.018, joint.radius * 0.86);
    [-1, 1].forEach((side) => {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(railWidth, railDepth, Math.max(0.025, length - 0.02)),
        jointIndex % 2 === 0 ? armBlackMaterial : armEdgeMaterial
      );
      rail.position.copy(direction.clone().multiplyScalar(0.5));
      rail.position.y += side * railOffset;
      rail.quaternion.copy(linkOrientation);
      pivot.add(rail);
    });

    const servo = new THREE.Mesh(
      new THREE.BoxGeometry(
        Math.max(0.052, joint.radius * 1.8),
        Math.max(0.072, joint.radius * 2.25),
        Math.max(0.048, joint.radius * 1.6)
      ),
      armServoMaterial
    );
    servo.position.copy(direction.clone().multiplyScalar(0.07));
    pivot.add(servo);

    const servoLabel = new THREE.Mesh(
      new THREE.BoxGeometry(
        Math.max(0.028, joint.radius),
        Math.max(0.074, joint.radius * 2.32),
        0.012
      ),
      armServoLabelMaterial
    );
    servoLabel.position.copy(servo.position);
    servoLabel.position.x += Math.max(0.032, joint.radius * 0.95);
    pivot.add(servoLabel);

    const axle = new THREE.Mesh(
      new THREE.CylinderGeometry(
        Math.max(0.012, joint.radius * 0.5),
        Math.max(0.012, joint.radius * 0.5),
        railOffset * 2.7,
        20
      ),
      armSilverMaterial
    );
    axle.rotation.x = Math.PI * 0.5;
    pivot.add(axle);

    [-1, 1].forEach((side) => {
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(
          Math.max(0.015, joint.radius * 0.62),
          Math.max(0.015, joint.radius * 0.62),
          0.006,
          20
        ),
        armSilverMaterial
      );
      cap.rotation.x = Math.PI * 0.5;
      cap.position.y = side * railOffset * 1.38;
      pivot.add(cap);
    });

    linkStates.push({
      axis: joint.axis,
      pivot,
      mesh,
      direction,
      length,
      color: joint.color,
      radius: joint.radius,
      worldStart: new THREE.Vector3(),
      worldEnd: new THREE.Vector3(),
    });

    parentGroup = pivot;
  });

  const toolDirection = new THREE.Vector3(...ARM_CONFIG.chain.at(-1).drawTo);
  const gripperRoot = new THREE.Group();
  gripperRoot.position.copy(toolDirection);
  parentGroup.add(gripperRoot);

  const gripperWrist = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.058, 24),
    armEdgeMaterial
  );
  gripperWrist.rotation.x = Math.PI * 0.5;
  gripperRoot.add(gripperWrist);

  const gripperBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.082, 0.075, 0.055),
    armBlackMaterial
  );
  gripperBody.position.z = 0.04;
  gripperRoot.add(gripperBody);

  [-1, 1].forEach((side) => {
    const fingerRoot = new THREE.Group();
    fingerRoot.position.set(0, side * 0.031, 0.068);
    gripperRoot.add(fingerRoot);

    const finger = new THREE.Mesh(
      new THREE.BoxGeometry(0.018, 0.016, 0.105),
      armBlackMaterial
    );
    finger.position.set(0.012, side * 0.012, 0.047);
    finger.rotation.x = side * -0.16;
    fingerRoot.add(finger);

    const tip = new THREE.Mesh(
      new THREE.BoxGeometry(0.034, 0.019, 0.018),
      armSilverMaterial
    );
    tip.position.set(-0.002, side * 0.022, 0.096);
    fingerRoot.add(tip);
  });

  const facilityFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(14.8, 16.8),
    new THREE.MeshLambertMaterial({ color: 0x1a252f })
  );
  facilityFloor.position.z = 0.001;
  gantrySceneGroup.add(facilityFloor);

  const sideRailMaterial = new THREE.MeshLambertMaterial({ color: 0x2d404c });
  const rollerMaterial = new THREE.MeshLambertMaterial({ color: 0xaab5bf });
  const frameMaterial = new THREE.MeshLambertMaterial({ color: 0x7cd1ff });
  const beamMaterial = new THREE.MeshLambertMaterial({ color: 0xd6ff57 });
  const toolMaterial = new THREE.MeshLambertMaterial({ color: 0xffb366 });
  const createPalletMesh = (baseColor, dims) => {
    const pallet = new THREE.Group();
    const topDeckMaterial = new THREE.MeshLambertMaterial({ color: baseColor + 0x0c0c0c });
    const bottomDeckMaterial = new THREE.MeshLambertMaterial({ color: baseColor - 0x101010 });
    const blockMaterial = new THREE.MeshLambertMaterial({ color: baseColor - 0x242424 });
    const stringerMaterial = new THREE.MeshLambertMaterial({ color: baseColor - 0x1a1a1a });

    const topDeckThickness = dims.z * 0.16;
    const bottomDeckThickness = dims.z * 0.12;
    const blockHeight = dims.z - topDeckThickness - bottomDeckThickness;

    const topBoardCount = 7;
    const topBoardWidth = dims.y * 0.1;
    const topBoardGap = (dims.y - topBoardCount * topBoardWidth) / (topBoardCount + 1);
    for (let i = 0; i < topBoardCount; i += 1) {
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(dims.x, topBoardWidth, topDeckThickness),
        topDeckMaterial
      );
      board.position.set(
        0,
        -dims.y * 0.5 + topBoardGap + topBoardWidth * 0.5 + i * (topBoardWidth + topBoardGap),
        dims.z - topDeckThickness * 0.5
      );
      pallet.add(board);
    }

    const bottomBoardCount = 3;
    const bottomBoardWidth = dims.y * 0.2;
    const bottomBoardGap = (dims.y - bottomBoardCount * bottomBoardWidth) / (bottomBoardCount + 1);
    for (let i = 0; i < bottomBoardCount; i += 1) {
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(dims.x * 0.92, bottomBoardWidth, bottomDeckThickness),
        bottomDeckMaterial
      );
      board.position.set(
        0,
        -dims.y * 0.5 + bottomBoardGap + bottomBoardWidth * 0.5 + i * (bottomBoardWidth + bottomBoardGap),
        bottomDeckThickness * 0.5
      );
      pallet.add(board);
    }

    const blockSizeX = dims.x * 0.14;
    const blockSizeY = dims.y * 0.18;
    const blockXs = [-dims.x * 0.36, 0, dims.x * 0.36];
    const blockYs = [-dims.y * 0.32, 0, dims.y * 0.32];
    blockXs.forEach((blockX) => {
      blockYs.forEach((blockY) => {
        const block = new THREE.Mesh(
          new THREE.BoxGeometry(blockSizeX, blockSizeY, blockHeight),
          blockMaterial
        );
        block.position.set(blockX, blockY, bottomDeckThickness + blockHeight * 0.5);
        pallet.add(block);
      });
    });

    const stringerWidth = dims.y * 0.14;
    [-dims.y * 0.32, 0, dims.y * 0.32].forEach((stringerY) => {
      const stringer = new THREE.Mesh(
        new THREE.BoxGeometry(dims.x * 0.86, stringerWidth, blockHeight * 0.32),
        stringerMaterial
      );
      stringer.position.set(0, stringerY, bottomDeckThickness + blockHeight * 0.7);
      pallet.add(stringer);
    });

    return pallet;
  };

  const addRollerStrip = (start, end, width = FACILITY_BELT_WIDTH) => {
    const tangent = end.clone().sub(start);
    const length = tangent.length();
    if (length < 0.02) {
      return;
    }
    tangent.normalize();
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0).normalize();
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const angleZ = Math.atan2(tangent.y, tangent.x);

    const railGeom = new THREE.BoxGeometry(length, 0.018, 0.03);
    const railA = new THREE.Mesh(railGeom, sideRailMaterial);
    railA.position.copy(mid.clone().add(normal.clone().multiplyScalar(width * 0.5)));
    railA.rotation.z = angleZ;
    gantrySceneGroup.add(railA);
    const railB = new THREE.Mesh(railGeom, sideRailMaterial);
    railB.position.copy(mid.clone().add(normal.clone().multiplyScalar(-width * 0.5)));
    railB.rotation.z = angleZ;
    gantrySceneGroup.add(railB);

    const rollerCount = Math.max(8, Math.floor(length / 0.09));
    const rollerSpacing = length / rollerCount;
    for (let i = 0; i <= rollerCount; i += 1) {
      const center = start.clone().add(tangent.clone().multiplyScalar(i * rollerSpacing));
      const roller = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, width * 0.9, 14),
        rollerMaterial
      );
      roller.position.copy(center);
      roller.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      gantrySceneGroup.add(roller);
    }
  };

  const conveyorStrips = [
    // Sketch layout: center trunk with two horizontal cross belts.
    { start: new THREE.Vector3(0.0, BELT_TRUNK_TOP_Y, FACILITY_BELT_Z), end: new THREE.Vector3(0.0, BELT_TRUNK_BOTTOM_Y, FACILITY_BELT_Z) },
    {
      start: new THREE.Vector3(-BELT_CROSS_HALF_SPAN, SOURCE_OFFLOAD_Y, FACILITY_BELT_Z),
      end: new THREE.Vector3(BELT_CROSS_HALF_SPAN, SOURCE_OFFLOAD_Y, FACILITY_BELT_Z),
    },
    {
      start: new THREE.Vector3(-BELT_CROSS_HALF_SPAN, LOWER_CROSS_BELT_Y, FACILITY_BELT_Z),
      end: new THREE.Vector3(BELT_CROSS_HALF_SPAN, LOWER_CROSS_BELT_Y, FACILITY_BELT_Z),
    },
  ];
  conveyorStrips.forEach(({ start, end }) => addRollerStrip(start, end));

  const addGantryCell = (id, x, y, span, dynamic = false, rotationRad = 0) => {
    const halfSpanX = span.x * 0.5;
    const halfSpanY = span.y * 0.5;
    const pillarX = Math.max(0.25, halfSpanX - GANTRY_DIMS.uprightSize * 0.5);
    const pillarY = Math.max(0.2, halfSpanY - GANTRY_DIMS.uprightSize * 0.5);
    const topRailLength = Math.max(0.5, span.x - GANTRY_DIMS.uprightSize * 0.35);
    const runwayLength = Math.max(0.5, span.y - GANTRY_DIMS.uprightSize * 0.35);
    const bridgeBeamLength = Math.max(0.45, topRailLength - 0.18);
    const travelX = Math.max(
      0.25,
      bridgeBeamLength * 0.5 - GANTRY_DIMS.carriageSize.x * 0.55
    );
    const travelY = Math.max(
      0.15,
      span.y * 0.5 - GANTRY_DIMS.carriageSize.y * 0.9
    );
    const cell = new THREE.Group();
    cell.name = id;
    cell.position.set(x, y, 0);
    cell.rotation.z = rotationRad;
    cell.visible = sceneItems[id] ?? true;
    gantrySceneGroup.add(cell);

    const uprightGeometry = new THREE.BoxGeometry(
      GANTRY_DIMS.uprightSize,
      GANTRY_DIMS.uprightSize,
      1.1
    );
    const pillarPositions = [
      [-pillarX, -pillarY, 0.55],
      [-pillarX, pillarY, 0.55],
      [pillarX, -pillarY, 0.55],
      [pillarX, pillarY, 0.55],
    ];
    pillarPositions.forEach((position) => {
      const upright = new THREE.Mesh(uprightGeometry, frameMaterial);
      upright.position.set(...position);
      cell.add(upright);

      const foot = new THREE.Mesh(
        new THREE.BoxGeometry(GANTRY_DIMS.uprightSize * 1.5, GANTRY_DIMS.uprightSize * 1.5, 0.03),
        new THREE.MeshLambertMaterial({ color: 0x4c6777 })
      );
      foot.position.set(position[0], position[1], 0.015);
      cell.add(foot);
    });

    const endTieA = new THREE.Mesh(
      new THREE.BoxGeometry(topRailLength, GANTRY_DIMS.topRailThickness, GANTRY_DIMS.topRailThickness),
      frameMaterial
    );
    endTieA.position.set(0, -pillarY, GANTRY_DIMS.topZ);
    cell.add(endTieA);
    const endTieB = endTieA.clone();
    endTieB.position.y = pillarY;
    cell.add(endTieB);

    const runwayGeom = new THREE.BoxGeometry(
      GANTRY_DIMS.topRailThickness,
      runwayLength,
      GANTRY_DIMS.topRailThickness
    );
    const runwayLeft = new THREE.Mesh(runwayGeom, frameMaterial);
    runwayLeft.position.set(-pillarX, 0, GANTRY_DIMS.topZ);
    cell.add(runwayLeft);
    const runwayRight = new THREE.Mesh(runwayGeom, frameMaterial);
    runwayRight.position.set(pillarX, 0, GANTRY_DIMS.topZ);
    cell.add(runwayRight);

    const railCapGeom = new THREE.BoxGeometry(0.05, runwayLength * 0.98, 0.02);
    const railCapLeft = new THREE.Mesh(railCapGeom, new THREE.MeshLambertMaterial({ color: 0xd4dee5 }));
    railCapLeft.position.set(-pillarX, 0, GANTRY_DIMS.topZ + GANTRY_DIMS.topRailThickness * 0.44);
    cell.add(railCapLeft);
    const railCapRight = new THREE.Mesh(railCapGeom, new THREE.MeshLambertMaterial({ color: 0xd4dee5 }));
    railCapRight.position.set(pillarX, 0, GANTRY_DIMS.topZ + GANTRY_DIMS.topRailThickness * 0.44);
    cell.add(railCapRight);

    const addBrace = (x1, y1, z1, x2, y2, z2) => {
      const start = new THREE.Vector3(x1, y1, z1);
      const end = new THREE.Vector3(x2, y2, z2);
      const delta = end.clone().sub(start);
      const length = delta.length();
      if (length < 0.02) {
        return;
      }
      const brace = new THREE.Mesh(
        new THREE.BoxGeometry(GANTRY_DIMS.braceThickness, GANTRY_DIMS.braceThickness, length),
        new THREE.MeshLambertMaterial({ color: 0x6aaeca })
      );
      brace.position.copy(start.clone().add(end).multiplyScalar(0.5));
      brace.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), delta.normalize());
      cell.add(brace);
    };

    // X-bracing across both gantry side faces for better lateral stiffness.
    const braceZLow = 0.18;
    const braceZHigh = GANTRY_DIMS.topZ - 0.08;
    addBrace(-pillarX, -pillarY, braceZLow, -pillarX, pillarY, braceZHigh);
    addBrace(-pillarX, pillarY, braceZLow, -pillarX, -pillarY, braceZHigh);
    addBrace(pillarX, -pillarY, braceZLow, pillarX, pillarY, braceZHigh);
    addBrace(pillarX, pillarY, braceZLow, pillarX, -pillarY, braceZHigh);

    const bridge = new THREE.Group();
    bridge.position.set(0, 0, GANTRY_DIMS.bridgeZ);
    cell.add(bridge);

    const bridgeBeam = new THREE.Mesh(
      new THREE.BoxGeometry(
        bridgeBeamLength,
        GANTRY_DIMS.bridgeRunnerWidth,
        GANTRY_DIMS.bridgeBeamThickness
      ),
      beamMaterial
    );
    bridge.add(bridgeBeam);

    const laneCount = GANTRY_ARM_CONFIG.count;
    const laneInset = 0.04;
    const laneSpan = Math.max(0.02, GANTRY_DIMS.bridgeRunnerWidth - laneInset * 2);
    const lanePitch = laneCount > 1 ? laneSpan / (laneCount - 1) : 0;
    const trackMat = new THREE.MeshLambertMaterial({ color: 0x9ab923 });
    for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
      const laneY = -laneSpan * 0.5 + lanePitch * laneIndex;
      const track = new THREE.Mesh(
        new THREE.BoxGeometry(bridgeBeamLength * 0.96, 0.018, 0.014),
        trackMat
      );
      track.position.set(0, laneY, GANTRY_DIMS.bridgeBeamThickness * 0.52);
      bridge.add(track);
    }

    const truckMaterial = new THREE.MeshLambertMaterial({ color: 0xf1f6fb });
    const truckGeom = new THREE.BoxGeometry(0.14, 0.12, 0.12);
    const truckX = bridgeBeamLength * 0.5 - 0.07;
    [-truckX, truckX].forEach((tx) => {
      const truck = new THREE.Mesh(truckGeom, truckMaterial);
      truck.position.set(tx, 0, 0);
      bridge.add(truck);

      const wheelGeom = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 14);
      const wheelMat = new THREE.MeshLambertMaterial({ color: 0x3a4650 });
      [-0.045, 0.045].forEach((wz) => {
        const wheel = new THREE.Mesh(wheelGeom, wheelMat);
        wheel.position.set(tx, 0, wz);
        wheel.rotation.z = Math.PI * 0.5;
        bridge.add(wheel);
      });
    });

    const armCount = GANTRY_ARM_CONFIG.count;
    const armTrackHalf = Math.max(
      0.45,
      bridgeBeamLength * 0.45 * GANTRY_ARM_CONFIG.runnerUtilization
    );
    const armPitch = armCount > 1 ? (armTrackHalf * 2) / (armCount - 1) : 0;
    const armCarriages = [];
    const armBodyMat = new THREE.MeshLambertMaterial({ color: 0xd7e4ec });
    const armRodMat = new THREE.MeshLambertMaterial({ color: 0x9fb0bc });
    const armToolMat = new THREE.MeshLambertMaterial({ color: 0xffb366 });
    const armCupMat = new THREE.MeshLambertMaterial({ color: 0x6c7f8c });
    for (let armIndex = 0; armIndex < armCount; armIndex += 1) {
      const laneY = -laneSpan * 0.5 + lanePitch * armIndex;
      const runnerArm = new THREE.Group();
      runnerArm.position.set(-armTrackHalf + armPitch * armIndex, laneY, 0);
      bridge.add(runnerArm);

      const shuttle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.1), armBodyMat);
      runnerArm.add(shuttle);

      const drop = new THREE.Group();
      // Start at idle drop immediately so arms are visibly hanging on first frame.
      drop.position.set(0, 0, -GANTRY_ARM_CONFIG.idleDrop);
      runnerArm.add(drop);

      const mastLength = 0.42;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, mastLength, 18), armRodMat);
      mast.position.z = -mastLength * 0.5;
      drop.add(mast);

      const tool = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.03), armToolMat);
      tool.position.z = -0.44;
      drop.add(tool);

      const armCups = [];
      [
        [-0.03, -0.03],
        [-0.03, 0.03],
        [0.03, -0.03],
        [0.03, 0.03],
      ].forEach(([cx, cy]) => {
        const cup = new THREE.Mesh(
          new THREE.CylinderGeometry(0.009, 0.011, 0.02, 12),
          armCupMat.clone()
        );
        cup.rotation.x = Math.PI * 0.5;
        cup.position.set(cx, cy, -0.46);
        drop.add(cup);
        armCups.push(cup);
      });

      armCarriages.push({
        group: runnerArm,
        homeX: -armTrackHalf + armPitch * armIndex,
        laneY,
        drop,
        cups: armCups,
        phase: armIndex * 0.9 + (dynamic ? 0.0 : 0.4),
      });
    }

    gantryArmSystems.push({
      bridge,
      centerX: x,
      centerY: y,
      dynamic,
      travelX,
      arms: armCarriages,
    });

    const carriage = new THREE.Group();
    bridge.add(carriage);
    const carriageBody = new THREE.Mesh(
      new THREE.BoxGeometry(
        GANTRY_DIMS.carriageSize.x,
        GANTRY_DIMS.carriageSize.y,
        GANTRY_DIMS.carriageSize.z
      ),
      new THREE.MeshLambertMaterial({ color: 0xf5fbff })
    );
    carriage.add(carriageBody);

    const hook = new THREE.Group();
    hook.position.set(0, 0, 0.62);
    carriage.add(hook);

    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.15, 18),
      new THREE.MeshLambertMaterial({ color: 0x45535f })
    );
    motor.rotation.z = Math.PI * 0.5;
    motor.position.set(0, 0, 0.05);
    carriage.add(motor);

    const hoistCable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.015, 0.015, 0.54, 14),
      toolMaterial
    );
    hoistCable.rotation.x = Math.PI / 2;
    hoistCable.position.z = -0.27;
    hook.add(hoistCable);

    const toolHead = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.04), toolMaterial);
    toolHead.position.z = -0.54;
    hook.add(toolHead);

    const hookBlock = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.06),
      new THREE.MeshLambertMaterial({ color: 0x5e6b75 })
    );
    hookBlock.position.z = -0.50;
    hook.add(hookBlock);

    const gripperPlate = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.02),
      new THREE.MeshLambertMaterial({ color: 0xced8df })
    );
    gripperPlate.position.z = -0.575;
    hook.add(gripperPlate);

    const cupOffsets = [
      [-0.05, -0.05],
      [-0.05, 0.05],
      [0.05, -0.05],
      [0.05, 0.05],
    ];
    const cupMaterial = new THREE.MeshLambertMaterial({ color: 0x6c7f8c });
    const cups = [];
    cupOffsets.forEach(([cx, cy]) => {
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.02, 0.04, 16),
        cupMaterial.clone()
      );
      cup.rotation.x = Math.PI / 2;
      cup.position.set(cx, cy, -0.605);
      hook.add(cup);
      cups.push(cup);
    });

    if (dynamic) {
      gantryTravelX = travelX;
      gantryTravelY = travelY;
      gantryBridge = bridge;
      gantryCarriage = carriage;
      gantryHook = hook;
      gantryGripperPad = gripperPlate;
      gantryGripperCups = cups;
    }

  };

  gantryArmSystems = [];
  getGantryCellSpecs().forEach(({ id, x, y, span, dynamic, rotationRad }) => {
    addGantryCell(id, x, y, span, dynamic, rotationRad);
  });

  // Source gantry feed area: 24 source pallets (12/side, 2x6 per side).
  getSourcePalletSlots(SOURCE_STACK_CENTER.x, SOURCE_STACK_CENTER.y).forEach(([px, py]) => {
    const sourcePallet = createPalletMesh(0x7a5334, SOURCE_PALLET_DIMS);
    sourcePallet.position.set(px, py, 0.001);
    gantrySceneGroup.add(sourcePallet);
  });
  sourceBoxMeshes = [];
  gantryAttachedSourceBox = null;
  const sourceBoxes = getSourceBoxPositions();
  sourceBoxes.forEach(([x, y, z]) => {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(BOX_DIMS.x, BOX_DIMS.y, BOX_DIMS.z),
      new THREE.MeshLambertMaterial({ color: 0xc9895d })
    );
    box.position.set(x, y, z);
    gantrySceneGroup.add(box);
    sourceBoxMeshes.push(box);
  });

  // Each offloading gantry gets 24 pallets: 12 per side as 4x3 banks.
  DESTINATION_CENTERS.forEach(([cx, cy], destinationIndex) => {
    const paletteBase = destinationIndex % 2 === 0 ? 0x9b6a43 : 0x8e5f3b;
    getDestinationPalletSlots(cx, cy).forEach(([px, py]) => {
      const pallet = createPalletMesh(paletteBase, DESTINATION_PALLET_DIMS);
      pallet.position.set(px, py, 0.001);
      gantrySceneGroup.add(pallet);
    });
  });

  applySceneVisibility();
}

function initializePhysics() {
  world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const fixedFloor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  floorCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(1.8, 1.8, 0.02).setTranslation(0, 0, -0.02),
    fixedFloor
  );

  const fixedTable = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  tableCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(
      ENVIRONMENT.tableSize.x / 2,
      ENVIRONMENT.tableSize.y / 2,
      ENVIRONMENT.tableSize.z / 2
    ).setTranslation(
      ENVIRONMENT.tableCenter.x,
      ENVIRONMENT.tableCenter.y,
      ENVIRONMENT.tableCenter.z
    ),
    fixedTable
  );

  colliderHandles = [];
  rigidBodies = [];
  linkStates.forEach((state) => {
    const rigidBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    const halfBody = Math.max(0.01, state.length / 2 - state.radius);
    const collider = world.createCollider(RAPIER.ColliderDesc.capsule(halfBody, state.radius), rigidBody);
    rigidBodies.push(rigidBody);
    colliderHandles.push(collider.handle);
  });
}

async function bootstrap() {
  await RAPIER.init();
  try {
    initializeScene();
    initializePhysics();
    updateViewerNotice();
  } catch (error) {
    console.error(error);
    try {
      initializeCanvasFallback();
      statusOutput.textContent = "WebGL unavailable; using 2D canvas fallback viewer.";
    } catch (fallbackError) {
      console.error(fallbackError);
      ensureViewerNotice().textContent = "Viewer unavailable: WebGL and 2D canvas both failed.";
      statusOutput.textContent = "Viewer initialization failed: WebGL context unavailable.";
      return;
    }
  }
  renderJointInputs(JOINT_NAMES);
  setJointValues(DEFAULT_ARM_POSE);
  updateArmKinematics(DEFAULT_ARM_POSE);
  updateCollisionState();
  renderPoseButtons(currentPredefinedPoses);
  renderSequenceButtons();
  renderCommandHistory();
  renderItemStatus();
  renderSceneItemSelect();
  renderImportedModelList();
  try {
    await loadCalibrationForBrowser();
  } catch (error) {
    if (calibrationStatus) {
      calibrationStatus.textContent = `Could not load calibration records: ${error.message}`;
    }
  }
  fetchCalibrationStatus();
  connectCalibrationStream();
  fetchStatus();
  setInterval(fetchStatus, STATUS_POLL_INTERVAL_MS);
  requestAnimationFrame(animate);
}

let hasBootstrapped = false;

export function bootstrapSceneRenderer() {
  if (hasBootstrapped) {
    return;
  }
  hasBootstrapped = true;
  bootstrap();
}

placeItemButton?.addEventListener("click", () => {
  setSceneItemPresence(sceneItemSelect.value, true);
});

removeItemButton?.addEventListener("click", () => {
  setSceneItemPresence(sceneItemSelect.value, false);
});

sceneSelect?.addEventListener("change", (event) => {
  currentSceneId = normalizeSceneId(event.target.value);
  gantryFocusIndex = -1;
  applySceneVisibility();
  if (useCanvasFallback) {
    resetFallbackCamera();
    return;
  }
  const preset = CAMERA_PRESETS[currentSceneId] || CAMERA_PRESETS.arm;
  camera.position.set(...preset.position);
  controls.target.set(...preset.target);
  controls.update();
});
