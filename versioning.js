console.log("hi it's versioning.js here; how are you?");
const fileListEl = document.getElementById('fileList');
const fileTitleEl = document.getElementById('fileTitle');
const navRowEl = document.getElementById('navRow');
const backBtn = document.getElementById('backBtn');
const forwardBtn = document.getElementById('forwardBtn');
const navLabelEl = document.getElementById('navLabel');
const statusEl = document.getElementById('status');
const contentArea = document.getElementById('contentArea');
const diffView = document.getElementById('diffView');
const previewFrame = document.getElementById('previewFrame');
const viewSourceBtn = document.getElementById('viewSourceBtn');
const viewIframeBtn = document.getElementById('viewIframeBtn');
const rollBackBtn = document.getElementById('rollBackBtn');
const rollForwardBtn = document.getElementById('rollForwardBtn');
const submitBtn = document.getElementById('submitBtn');

const DiffLib = window.Diff || null;
const snapshotCache = new Map();
const patchCache = new Map();
const savedDiffs = new Set();
const fileButtons = new Map();
let baselineContent = '';
let currentContent = '';
let currentIndex = 0;
let currentFile = '';
let currentHistory = [];
let firstFile = null;
let firstButton = null;
let pendingOpen = false;
let viewMode = 'source';

async function fetchHtmlFiles() {
  try {
    const res = await fetch('/files');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.files)) {
        return data.files.filter((path) => !path.includes('/')).sort();
      }
    }
  } catch {}
  if (typeof import.meta !== 'undefined' && typeof import.meta.glob === 'function') {
    const files = Object.keys(import.meta.glob('./*.html', { query: '?url', import: 'default', eager: true }))
      .map((path) => path.replace(/^\.\//, ''))
      .filter((path) => path !== 'index.html');
    return Array.from(new Set(files)).sort();
  }
  return [];
}

async function fetchSnapshotDirs() {
  const res = await fetch('/.codex_snapshots/');
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const dirs = Array.from(doc.querySelectorAll('a'))
    .map((a) => a.getAttribute('href'))
    .filter((href) => href && /\/$/.test(href))
    .map((href) => href.replace(/\/$/, ''))
    .filter((name) => /^\d{8}_\d{6}$/.test(name));
  return Array.from(new Set(dirs)).sort().reverse();
}

async function fetchSummary(timestamp) {
  try {
    const res = await fetch(`/.codex_snapshots/${timestamp}/summary.txt`);
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

async function fileExists(path) {
  const res = await fetch(path, { method: 'HEAD' });
  return res.ok;
}

function formatMeta(info) {
  if (!info) return 'No snapshot info.';
  return [
    `File: ${info.file}`,
    `Snapshot: ${info.timestamp}`,
    `Changes back: ${info.backIndex}`,
    info.summary ? `Description: ${info.summary}` : 'Description: (none)'
  ].join('\n');
}

async function buildHistory(filePath) {
  const dirs = await fetchSnapshotDirs();
  const hits = [];
  for (const dir of dirs) {
    const snapshotPath = `/.codex_snapshots/${dir}/${filePath}`;
    if (await fileExists(snapshotPath)) {
      hits.push({ timestamp: dir, snapshotPath });
    }
  }
  return hits;
}

async function fetchFileContent(path) {
  const url = path.startsWith('/') ? path : `/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return await res.text();
}

async function getSnapshotContent(entry) {
  if (snapshotCache.has(entry.timestamp)) {
    return snapshotCache.get(entry.timestamp);
  }
  const res = await fetch(entry.snapshotPath);
  if (!res.ok) throw new Error(`Failed to load snapshot ${entry.timestamp}`);
  const text = await res.text();
  snapshotCache.set(entry.timestamp, text);
  return text;
}

async function getPatch(entry) {
  if (patchCache.has(entry.timestamp)) {
    return patchCache.get(entry.timestamp);
  }
  const snapshot = await getSnapshotContent(entry);
  const patch = DiffLib.createPatch(currentFile, baselineContent, snapshot);
  patchCache.set(entry.timestamp, patch);
  if (!savedDiffs.has(entry.timestamp)) {
    savedDiffs.add(entry.timestamp);
    fetch('/save-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, timestamp: entry.timestamp, patch })
    }).catch(() => {});
  }
  return patch;
}

function setViewState(label, text) {
  navLabelEl.textContent = label;
  currentContent = text;
  contentArea.value = text;
  updateDiffView();
  updatePreview();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function updateDiffView() {
  if (!diffView || !DiffLib) return;
  diffView.innerHTML = '';
  if (!baselineContent || currentContent === baselineContent) {
    diffView.textContent = 'No changes from baseline.';
    return;
  }
  const parts = DiffLib.diffLines(baselineContent, currentContent);
  const fragment = document.createDocumentFragment();
  parts.forEach((part) => {
    const lines = part.value.split('\n');
    lines.forEach((line, index) => {
      if (line === '' && index === lines.length - 1) return;
      const div = document.createElement('div');
      div.className = `diff-line ${part.added ? 'add' : part.removed ? 'remove' : 'same'}`;
      div.innerHTML = escapeHtml(`${part.added ? '+' : part.removed ? '-' : ' '} ${line}`);
      fragment.appendChild(div);
    });
  });
  diffView.appendChild(fragment);
}

function updatePreview() {
  if (!previewFrame) return;
  previewFrame.srcdoc = currentContent || '';
}

function setViewMode(mode) {
  viewMode = mode;
  const showSource = mode === 'source';
  viewSourceBtn.classList.toggle('active', showSource);
  viewIframeBtn.classList.toggle('active', !showSource);
  contentArea.hidden = !showSource;
  diffView.hidden = !showSource;
  previewFrame.hidden = showSource;
}

function updateButtons() {
  backBtn.disabled = currentIndex >= currentHistory.length;
  forwardBtn.disabled = currentIndex <= 0;
  submitBtn.disabled = !currentFile;
  if (rollBackBtn) rollBackBtn.disabled = backBtn.disabled;
  if (rollForwardBtn) rollForwardBtn.disabled = forwardBtn.disabled;
}

async function showCurrentIndex() {
  if (currentIndex === 0) {
    setViewState('Current file (baseline)', baselineContent);
    updateButtons();
    return;
  }
  const entry = currentHistory[currentIndex - 1];
  if (!entry) return;
  try {
    const patch = await getPatch(entry);
    const patched = DiffLib.applyPatch(baselineContent, patch);
    if (patched === false) {
      const snapshot = await getSnapshotContent(entry);
      setViewState(`Snapshot ${entry.timestamp}`, snapshot);
    } else {
      setViewState(`Snapshot ${entry.timestamp}`, patched);
    }
  } catch (err) {
    statusEl.textContent = `Failed to load snapshot: ${err.message}`;
  }
  updateButtons();
}

function setActiveButton(button) {
  if (!button) return;
  document.querySelectorAll('button.file').forEach((btn) => {
    btn.classList.toggle('active', btn === button);
  });
}

async function selectFile(filePath, button) {
  setActiveButton(button);
  fileTitleEl.textContent = filePath;
  statusEl.textContent = '';
  navRowEl.hidden = true;
  contentArea.hidden = true;
  diffView.hidden = true;
  submitBtn.disabled = true;
  snapshotCache.clear();
  patchCache.clear();
  savedDiffs.clear();
  currentIndex = 0;
  currentFile = filePath;

  if (!DiffLib) {
    statusEl.textContent = 'Diff library not loaded.';
    return;
  }

  baselineContent = await fetchFileContent(filePath);
  const history = await buildHistory(filePath);
  currentHistory = history;
  currentIndex = 0;
  contentArea.hidden = false;
  diffView.hidden = false;
  navRowEl.hidden = history.length === 0;
  setViewMode(viewMode);

  if (!history.length) {
    setViewState('Current file (baseline)', baselineContent);
    updateButtons();
    return;
  }

  backBtn.onclick = async () => {
    if (currentIndex >= currentHistory.length) return;
    currentIndex += 1;
    const entry = currentHistory[currentIndex - 1];
    await showCurrentIndex();
    const summary = await fetchSummary(entry.timestamp);
    statusEl.textContent = formatMeta({
      file: filePath,
      timestamp: entry.timestamp,
      backIndex: currentIndex,
      summary
    });
  };
  forwardBtn.onclick = async () => {
    if (currentIndex <= 0) return;
    currentIndex -= 1;
    if (currentIndex === 0) {
      statusEl.textContent = 'Viewing current file baseline.';
      await showCurrentIndex();
      return;
    }
    const entry = currentHistory[currentIndex - 1];
    await showCurrentIndex();
    const summary = await fetchSummary(entry.timestamp);
    statusEl.textContent = formatMeta({
      file: filePath,
      timestamp: entry.timestamp,
      backIndex: currentIndex,
      summary
    });
  };

  if (rollBackBtn) {
    rollBackBtn.onclick = backBtn.onclick;
  }
  if (rollForwardBtn) {
    rollForwardBtn.onclick = forwardBtn.onclick;
  }

  contentArea.oninput = () => {
    currentContent = contentArea.value;
    updateDiffView();
    updatePreview();
  };

  submitBtn.onclick = () => {
    if (!currentFile) return;
    statusEl.textContent = 'Saving...';
    fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: currentFile, content: currentContent })
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statusEl.textContent = 'Saved current content.';
    }).catch((err) => {
      statusEl.textContent = `Save failed: ${err.message}`;
    });
  };

  setViewState('Current file (baseline)', baselineContent);
  statusEl.textContent = 'Viewing current file baseline.';
  updateButtons();
}

async function init() {
  const files = await fetchHtmlFiles();
  fileListEl.innerHTML = '';
  files.forEach((filePath) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'file';
    btn.textContent = filePath;
    btn.addEventListener('click', () => selectFile(filePath, btn));
    li.appendChild(btn);
    fileListEl.appendChild(li);
    fileButtons.set(filePath, btn);
    if (!firstFile) {
      firstFile = filePath;
      firstButton = btn;
    }
  });
  if (pendingOpen && firstFile && firstButton && !currentFile) {
    selectFile(firstFile, firstButton);
  }
}

init();

window.addEventListener('versioning-open', () => {
  console.log('[versioning] open event');
  pendingOpen = true;
  if (currentFile || !firstFile || !firstButton) return;
  selectFile(firstFile, firstButton);
});

window.versioningSelectFile = (filePath) => {
  const button = fileButtons.get(filePath) || null;
  selectFile(filePath, button);
};

if (viewSourceBtn && viewIframeBtn) {
  viewSourceBtn.addEventListener('click', () => setViewMode('source'));
  viewIframeBtn.addEventListener('click', () => setViewMode('iframe'));
}
