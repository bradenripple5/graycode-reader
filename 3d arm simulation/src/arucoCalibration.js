import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./styles.css";
import "./arucoCalibration.css";

const MARKERS = [
  { id: 0, label: "Base", color: 0xd6ff57 },
  { id: 1, label: "Shoulder link", color: 0x7cd1ff },
  { id: 2, label: "Elbow link", color: 0xff9f43 },
  { id: 3, label: "Wrist link", color: 0xd980fa },
];
const JOINTS = [
  { name: "shoulder", label: "Shoulder", parent: 0, child: 1, feed: "dual:0x68" },
  { name: "elbow", label: "Elbow", parent: 1, child: 2, feed: "dual:0x69" },
  { name: "wrist", label: "Wrist", parent: 2, child: 3, feed: "single:0x68" },
];
const MIN_FRAMES = 30;
const MIN_SPAN_DEG = 25;
const MIN_INDEPENDENT_TRAVEL_DEG = 15;
const MAX_P95_ERROR_DEG = 2;
const MAX_ACCEL_TIME_DELTA_MS = 150;

const connectionOutput = document.getElementById("aruco-connection");
const sampleCountOutput = document.getElementById("aruco-sample-count");
const frameTimeOutput = document.getElementById("aruco-frame-time");
const readinessContainer = document.getElementById("joint-readiness");
const markerCards = document.getElementById("marker-cards");
const accelerometerRows = document.getElementById("aruco-accelerometers");
const resetButton = document.getElementById("aruco-reset");
const exportButton = document.getElementById("aruco-export");
const completeButton = document.getElementById("aruco-complete");
const canvas = document.getElementById("aruco-viewer");

let samples = [];
let latestKey = "";
let currentAnalysis = null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1115);
const camera = new THREE.PerspectiveCamera(55, 1, 0.005, 20);
camera.position.set(0.35, 0.2, 0.15);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, -0.55);
controls.update();
scene.add(new THREE.HemisphereLight(0xffffff, 0x263442, 2.2));
const cameraOrigin = new THREE.AxesHelper(0.12);
scene.add(cameraOrigin);

const markerGroups = new Map();
MARKERS.forEach(({ id, color }) => {
  const group = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.003),
    new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.65 })
  );
  group.add(plate);
  group.add(new THREE.AxesHelper(0.075));
  group.visible = false;
  markerGroups.set(id, group);
  scene.add(group);
});

function resizeViewer() {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  resizeViewer();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

function markerMap(sample) {
  return new Map((sample?.markers || []).map((marker) => [Number(marker.id), marker]));
}

function quaternionFromRvec(rvec) {
  const vector = new THREE.Vector3(...(rvec || [0, 0, 0]));
  const angle = vector.length();
  if (angle < 1e-10) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromAxisAngle(vector.multiplyScalar(1 / angle), angle);
}

function relativeQuaternion(parentMarker, childMarker) {
  const parent = quaternionFromRvec(parentMarker.rvec);
  const child = quaternionFromRvec(childMarker.rvec);
  return parent.invert().multiply(child).normalize();
}

function rotationVectorDegrees(reference, current) {
  const delta = reference.clone().invert().multiply(current).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const angle = 2 * Math.acos(Math.max(-1, Math.min(1, delta.w)));
  const sine = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
  if (sine < 1e-8 || angle < 1e-8) return new THREE.Vector3();
  return new THREE.Vector3(delta.x / sine, delta.y / sine, delta.z / sine)
    .multiplyScalar(THREE.MathUtils.radToDeg(angle));
}

function shortestDelta(from, to) {
  let delta = to - from;
  while (delta <= -180) delta += 360;
  while (delta > 180) delta -= 360;
  return delta;
}

function percentile(values, fraction) {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function linearFit(points) {
  if (points.length < 2) return null;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let variance = 0;
  let covariance = 0;
  points.forEach((point) => {
    variance += (point.x - meanX) ** 2;
    covariance += (point.x - meanX) * (point.y - meanY);
  });
  if (variance < 0.01) return null;
  const slope = covariance / variance;
  const intercept = meanY - slope * meanX;
  const residuals = points.map((point) => Math.abs(point.y - (slope * point.x + intercept)));
  return { slope, intercept, residuals };
}

function analyzeSamples() {
  const complete = samples.filter((sample) => {
    const markers = markerMap(sample);
    return MARKERS.every(({ id }) => markers.has(id));
  });
  const analysis = { completeFrames: complete.length, joints: {}, ready: false };
  if (!complete.length) return analysis;

  const references = {};
  const rotationVectors = {};
  JOINTS.forEach((joint) => {
    const firstMarkers = markerMap(complete[0]);
    references[joint.name] = relativeQuaternion(
      firstMarkers.get(joint.parent), firstMarkers.get(joint.child)
    );
    rotationVectors[joint.name] = complete.map((sample) => {
      const markers = markerMap(sample);
      return rotationVectorDegrees(
        references[joint.name],
        relativeQuaternion(markers.get(joint.parent), markers.get(joint.child))
      );
    });
  });

  const groundTruth = {};
  JOINTS.forEach((joint) => {
    const vectors = rotationVectors[joint.name];
    const largest = vectors.reduce(
      (best, vector) => vector.lengthSq() > best.lengthSq() ? vector : best,
      new THREE.Vector3()
    );
    const axis = largest.lengthSq() > 1 ? largest.clone().normalize() : new THREE.Vector3(1, 0, 0);
    groundTruth[joint.name] = vectors.map((vector) => vector.dot(axis));
  });

  JOINTS.forEach((joint) => {
    const ground = groundTruth[joint.name];
    const points = [];
    let previousSensor = null;
    let unwrappedSensor = 0;
    complete.forEach((sample, index) => {
      const feed = sample.accelerometers?.[joint.feed];
      const sensor = Number(feed?.angle);
      const timeDelta = Math.abs(Number(feed?.camera_delta_ms));
      if (!Number.isFinite(sensor) || !Number.isFinite(timeDelta) || timeDelta > MAX_ACCEL_TIME_DELTA_MS) return;
      if (previousSensor == null) {
        previousSensor = sensor;
        unwrappedSensor = sensor;
      } else {
        unwrappedSensor += shortestDelta(previousSensor, sensor);
        previousSensor = sensor;
      }
      points.push({ x: unwrappedSensor, y: ground[index] });
    });

    let independentTravel = 0;
    for (let index = 1; index < complete.length; ++index) {
      const ownChange = Math.abs(ground[index] - ground[index - 1]);
      const otherChange = Math.max(...JOINTS
        .filter((candidate) => candidate.name !== joint.name)
        .map((candidate) => Math.abs(
          groundTruth[candidate.name][index] - groundTruth[candidate.name][index - 1]
        )));
      if (ownChange >= 0.2 && otherChange <= Math.max(0.25, ownChange * 0.35)) {
        independentTravel += ownChange;
      }
    }

    const fit = linearFit(points);
    const orderedPoints = [...points].sort((left, right) => left.x - right.x);
    const trainingPoints = orderedPoints.filter((_point, index) => index % 2 === 0);
    const validationPoints = orderedPoints.filter((_point, index) => index % 2 === 1);
    const validationFit = linearFit(trainingPoints);
    const validationErrors = validationFit
      ? validationPoints.map((point) => Math.abs(
        point.y - (validationFit.slope * point.x + validationFit.intercept)
      ))
      : [];
    const span = ground.length ? Math.max(...ground) - Math.min(...ground) : 0;
    const p95Error = validationErrors.length
      ? percentile(validationErrors, 0.95)
      : Infinity;
    const passed = points.length >= MIN_FRAMES
      && span >= MIN_SPAN_DEG
      && independentTravel >= MIN_INDEPENDENT_TRAVEL_DEG
      && p95Error <= MAX_P95_ERROR_DEG;
    analysis.joints[joint.name] = {
      label: joint.label,
      feed: joint.feed,
      frames: points.length,
      span,
      independentTravel,
      p95Error,
      validationFrames: validationErrors.length,
      slope: fit?.slope ?? null,
      intercept: fit?.intercept ?? null,
      passed,
    };
  });
  analysis.ready = JOINTS.every((joint) => analysis.joints[joint.name]?.passed);
  return analysis;
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function renderReadiness() {
  currentAnalysis = analyzeSamples();
  readinessContainer.innerHTML = JOINTS.map((joint) => {
    const result = currentAnalysis.joints[joint.name] || {};
    return `<article class="readiness-card ${result.passed ? "pass" : ""}">
      <h3>${result.passed ? "✓" : "○"} ${joint.label}</h3>
      <dl>
        <dt>Synchronized frames</dt><dd>${result.frames || 0} / ${MIN_FRAMES}</dd>
        <dt>Observed span</dt><dd>${formatNumber(result.span)}° / ${MIN_SPAN_DEG}°</dd>
        <dt>Independent travel</dt><dd>${formatNumber(result.independentTravel)}° / ${MIN_INDEPENDENT_TRAVEL_DEG}°</dd>
        <dt>95% error</dt><dd>${formatNumber(result.p95Error)}° / ±${MAX_P95_ERROR_DEG}°</dd>
      </dl>
    </article>`;
  }).join("");
  const count = currentAnalysis.completeFrames;
  sampleCountOutput.textContent = `${count} synchronized frame${count === 1 ? "" : "s"}`;
  sampleCountOutput.className = `sync-status ${currentAnalysis.ready ? "sync-ok" : "sync-warn"}`;
  completeButton.disabled = !currentAnalysis.ready;
}

function renderLatest(sample) {
  const markers = markerMap(sample);
  MARKERS.forEach(({ id }) => {
    const marker = markers.get(id);
    const group = markerGroups.get(id);
    group.visible = Boolean(marker);
    if (!marker) return;
    const [x, y, z] = marker.tvec;
    group.position.set(x, -y, -z);
    const rawRotation = quaternionFromRvec(marker.rvec);
    const conversion = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));
    group.quaternion.copy(conversion).multiply(rawRotation).multiply(conversion.clone().invert());
  });

  markerCards.innerHTML = MARKERS.map(({ id, label }) => {
    const marker = markers.get(id);
    return `<article class="marker-card"><h3>${marker ? "●" : "○"} ${id} ${label}</h3><dl>
      <dt>Translation (m)</dt><dd>${marker ? marker.tvec.map((value) => formatNumber(value, 3)).join(", ") : "not visible"}</dd>
      <dt>Rotation vector</dt><dd>${marker ? marker.rvec.map((value) => formatNumber(value, 3)).join(", ") : "—"}</dd>
    </dl></article>`;
  }).join("");

  const feeds = sample.accelerometers || {};
  const rows = Object.entries(feeds).map(([key, reading]) => {
    const accel = reading.accel || {};
    const gyro = reading.gyro || {};
    return `<tr><td>${key}</td>
      <td>${[accel.x, accel.y, accel.z].map((value) => formatNumber(value, 3)).join(", ")}</td>
      <td>${[gyro.x, gyro.y, gyro.z].map((value) => formatNumber(value, 2)).join(", ")}</td>
      <td>${formatNumber(reading.angle)}°</td>
      <td>${formatNumber(reading.camera_delta_ms, 0)} ms</td></tr>`;
  });
  accelerometerRows.innerHTML = rows.length ? rows.join("") : '<tr><td colspan="5">Waiting for accelerometers…</td></tr>';
  frameTimeOutput.textContent = `Frame ${sample.frame ?? "?"} · ${new Date(sample.camera_ts_ms).toLocaleTimeString()}${sample.intrinsics_approximate ? " · approximate camera intrinsics" : ""}`;
}

function ingestSample(sample, rerender = true) {
  if (!sample) return;
  const key = `${sample.camera_ts_ms}:${sample.frame}`;
  if (key === latestKey) return;
  latestKey = key;
  samples.push(sample);
  if (samples.length > 4000) samples.splice(0, samples.length - 4000);
  renderLatest(sample);
  if (rerender) renderReadiness();
  connectionOutput.textContent = `Live camera frame received · ${sample.markers?.length || 0}/4 markers visible`;
}

async function loadSession() {
  try {
    const response = await fetch("/api/calibration/aruco/status?samples=1", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    samples = [];
    latestKey = "";
    (payload.samples || []).forEach((sample) => ingestSample(sample, false));
    renderReadiness();
    if (payload.calibration_result) {
      connectionOutput.textContent = `Calibration was marked complete at ${new Date(payload.calibration_result.saved_at).toLocaleString()}`;
    }
  } catch (error) {
    connectionOutput.textContent = `Could not load ArUco session: ${error.message}`;
  }
}

function connectStream() {
  const stream = new EventSource("/api/calibration/stream?source=accel");
  stream.onmessage = (event) => {
    try { ingestSample(JSON.parse(event.data)?.aruco?.latest); } catch (_error) {}
  };
  stream.onerror = () => {
    connectionOutput.textContent = "Calibration stream disconnected; reconnecting…";
  };
}

resetButton.addEventListener("click", async () => {
  if (!window.confirm("Clear all recorded ArUco frames for this session?")) return;
  await fetch("/api/calibration/aruco/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  samples = [];
  latestKey = "";
  renderReadiness();
  connectionOutput.textContent = "Session reset; waiting for marker frames…";
});

exportButton.addEventListener("click", () => {
  const payload = {
    exported_at: new Date().toISOString(),
    criteria: {
      minimum_frames: MIN_FRAMES,
      minimum_span_deg: MIN_SPAN_DEG,
      minimum_independent_travel_deg: MIN_INDEPENDENT_TRAVEL_DEG,
      maximum_p95_error_deg: MAX_P95_ERROR_DEG,
      maximum_accelerometer_time_delta_ms: MAX_ACCEL_TIME_DELTA_MS,
    },
    analysis: currentAnalysis,
    samples,
  };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  link.download = `aruco-arm-calibration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
});

completeButton.addEventListener("click", async () => {
  if (!currentAnalysis?.ready) return;
  const response = await fetch("/api/calibration/aruco/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: currentAnalysis }),
  });
  if (response.ok) {
    completeButton.textContent = "✓ Properly Calibrated";
    completeButton.disabled = true;
    connectionOutput.textContent = "Calibration result saved in the calibration bridge.";
  }
});

async function bootstrap() {
  await loadSession();
  connectStream();
}

void bootstrap();
