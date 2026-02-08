const DEFAULT_PDB = "6LYZ";
const DEBUG = new URLSearchParams(window.location.search).has("debug");
function dbg(...args) { if (DEBUG) console.log("[DBG]", ...args); }

const displayInterval = 30000; // 30 seconds in milliseconds
let currentIndex = 0;
let isPaused = false;
let intervalHandle;
let currentPdbIds = [];

async function fetchPdbIds() {
  const url = "https://data.rcsb.org/rest/v1/holdings/current/entry_ids?list_type=entry_ids";
  try {
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      return data;
    } else {
      // surface HTTP error information
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }
  } catch (err) {
    // Likely network/CORS failure or other fetch issue
    console.error(`Error fetching PDB IDs from ${url}:`, err);
    throw err;
  }
}

// Replace the original hardcoded pdbIds array with this new async function
async function getPdbIds() {
  try {
    const entryIds = await fetchPdbIds();
    const randomIndices = generateRandomIndices(15, entryIds.length);
    return randomIndices.map(index => entryIds[index]);
  } catch (error) {
    console.error("Error fetching PDB IDs:", error);
    return [];
  }
}

// Add this function to generate an array of unique random indices
function generateRandomIndices(count, max) {
  const indices = new Set();
  while (indices.size < count) {
    indices.add(Math.floor(Math.random() * max));
  }
  return Array.from(indices);
}

const FALLBACK_PDB = "1CRN";

function setStatus(text, status) {
  const badge = document.getElementById("status-badge");
  if (!badge) return;
  badge.textContent = text;
  badge.dataset.status = status || "";
}

// Load DEFAULT_PDB immediately, then fetch PDB list in background for slideshow nav.
async function initSlideshow() {
  dbg("initSlideshow: loading DEFAULT_PDB", DEFAULT_PDB);
  currentPdbIds = [DEFAULT_PDB, FALLBACK_PDB];
  currentIndex = 0;

  try {
    await loadProteinStructure(DEFAULT_PDB);
    dbg("initSlideshow: DEFAULT_PDB loaded successfully");
  } catch (err) {
    console.error("Failed to load DEFAULT_PDB", DEFAULT_PDB, err);
    dbg("initSlideshow: trying FALLBACK_PDB", FALLBACK_PDB);
    try {
      await loadProteinStructure(FALLBACK_PDB);
    } catch (err2) {
      console.error("Failed to load FALLBACK_PDB", FALLBACK_PDB, err2);
      showLoadError(FALLBACK_PDB, err2);
    }
  }

  // Fetch full PDB list in background so forward/back buttons work
  getPdbIds().then((ids) => {
    if (ids && ids.length > 0) {
      currentPdbIds = ids;
      if (!currentPdbIds.includes(DEFAULT_PDB)) {
        currentPdbIds.unshift(DEFAULT_PDB);
      }
      currentIndex = currentPdbIds.indexOf(DEFAULT_PDB);
      if (currentIndex < 0) currentIndex = 0;
      dbg("PDB list loaded:", currentPdbIds.length, "entries");
    } else {
      const fallback = [DEFAULT_PDB, FALLBACK_PDB, "4HHB", "1A4W", "2HYY", "6VXX", "1UBQ", "2OOB", "3LZT", "5XNL"];
      console.warn("Using fallback PDB IDs.", fallback);
      currentPdbIds = fallback;
      currentIndex = 0;
    }
  });
}

function showLoadError(pdbId, err) {
  const msg = err && err.message ? err.message : String(err);
  const modelNameEl = document.getElementById("model-name");
  if (modelNameEl) modelNameEl.textContent = pdbId + " (failed)";
  if (interactionResultsEl) {
    interactionResultsEl.textContent = "Load failed: " + msg + ". Try a different PDB ID.";
    interactionResultsEl.dataset.state = "info-error";
  }
  if (metadataContentEl) {
    metadataContentEl.innerHTML = "";
    const errDiv = document.createElement("div");
    errDiv.className = "metadata-error";
    errDiv.textContent = "Failed to load " + pdbId + ": " + msg;
    metadataContentEl.appendChild(errDiv);
  }
}

function logShownEntity(pdbId) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] Shown entity: ${pdbId}`);
}




const CONTACT_DISTANCE_CUTOFF = 20.0; // Å — precompute contacts up to 20Å; UI slider controls display threshold

function tuneStagePerformance(currentStage) {
  if (!currentStage) return;
  currentStage.setParameters({
    quality: "medium",
    sampleLevel: 0,
    postProcessing: false,
    impostor: true,
    workerDefault: true,
  });
  if (currentStage.viewer && currentStage.viewer.renderer) {
    const renderer = currentStage.viewer.renderer;
    const targetRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(targetRatio);
  }
}

function tuneStageControls(currentStage) {
  if (!currentStage || !currentStage.viewer || !currentStage.viewer.controls) return;
  const controls = currentStage.viewer.controls;
  controls.zoomSpeed = 1.35;
  controls.rotateSpeed = 1.05;
  controls.panSpeed = 1.1;
  controls.staticMoving = true;
  controls.dynamicDampingFactor = 0.12;
}

dbg("Creating NGL.Stage on #viewport");
const stage = new NGL.Stage("viewport");
dbg("NGL.Stage created");
tuneStagePerformance(stage);
tuneStageControls(stage);
if (typeof stage.setBackground === "function") {
  stage.setBackground("#020617", "#0f172a");
} else if (stage.viewer && typeof stage.viewer.setBackground === "function") {
  stage.viewer.setBackground("#020617", "#0f172a");
}

const playPauseButton = document.getElementById("play-pause");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const metadataContentEl = document.getElementById("metadata-content");
const representationButtons = Array.from(document.querySelectorAll("[data-representation]"));
const pdbSearchInput = document.getElementById("pdb-search-input");
const pdbSearchButton = document.getElementById("pdb-search-button");
const proximitySlider = document.getElementById("proximity-threshold");
const proximityValueEl = document.getElementById("proximity-value");
const interactionResultsEl = document.getElementById("interaction-results");
const toggleSpinButton = document.getElementById("toggle-spin");

if (interactionResultsEl && !interactionResultsEl.dataset.state) {
  interactionResultsEl.dataset.state = "info-default";
}

let metadataRequestToken = 0;
let structureRequestToken = 0;
// Current active load session. Each load creates a new session object so async
// steps (fetches, parsing) can check session.id and can be aborted via AbortController.
let currentLoadSession = null;

function createLoadSession(pdbId) {
  // abort previous session controllers
  if (currentLoadSession && Array.isArray(currentLoadSession.controllers)) {
    currentLoadSession.controllers.forEach((c) => {
      try {
        if (c && typeof c.abort === 'function') c.abort();
      } catch (e) {
        // ignore
      }
    });
  }

  const session = {
    id: ++structureRequestToken,
    pdbId,
    controllers: [], // AbortController instances for network work in this session
  };
  currentLoadSession = session;
  return session;
}
const FILTER_DEBOUNCE_MS = 75;
const DEFAULT_ANALYSIS_MESSAGE = "Select 2\u201310 residues, then Analyze.";
const SELECTED_RESIDUE_COLOR = "#38bdf8";
const TYPE_CUTOFFS = {
  "Hydrogen Bond": 3.5,
  "Salt Bridge": 4.0,
  "Ionic Interaction": 6.0,
  "Disulfide Bond": 2.2,
};
const SWEEP_MIN = 2.0;
const SWEEP_MAX = 10.0;
const SWEEP_STEP = 0.5;

let currentComponent = null;
let currentRepresentationMode = "cartoon";
let currentStructure = null;
let interactionShapeComponent = null;
let lastHighlightSelection = null;
let isSpinning = false;
let representationHandles = {};
let residueDataset = { list: [], map: new Map(), contactMap: new Map() };
let residueColorMap = new Map();
let selectedResidueVisuals = new Map();
let focusTimeout = null;
let proximityThreshold = CONTACT_DISTANCE_CUTOFF;
let interactionCache = new Map();
let applyFilterTimeout = null;
let hasAutoFocusedForStructure = false;
let stabilityMode = false;
let stabilityData = [];
let sweepValue = SWEEP_MIN;
let sweepAnimationId = null;
let isSweeping = false;
let lastAnalyzedInteractions = [];

const representationConfigs = {
  cartoon: [
    {
      type: "cartoon",
      params: {
        colorScheme: "chainname",
        tension: 0.4,
        aspectRatio: 3,
        sele: "polymer",
      },
    },
  ],
  surface: [
    {
      type: "surface",
      params: {
        sele: "polymer",
        surfaceType: "msms",
        smooth: 1,
        opacity: 0.68,
        contour: false,
        colorScheme: "hydrophobicity",
        useWorker: true,
        lowResolution: true,
      },
    },
  ],
  "ball+stick": [
    {
      type: "ball+stick",
      params: {
        multipleBond: true,
        radiusScale: 0.24,
        sele: "polymer",
        colorScheme: "element",
      },
    },
  ],
};

const BACKBONE_ATOMS = new Set(["N", "CA", "C", "O", "OXT"]);

const HYDROGEN_DONOR_MAP = {
  ARG: ["NE", "NH1", "NH2"],
  ASN: ["ND2"],
  CYS: ["SG"],
  GLN: ["NE2"],
  HIS: ["ND1", "NE2"],
  LYS: ["NZ"],
  SER: ["OG"],
  THR: ["OG1"],
  TRP: ["NE1"],
  TYR: ["OH"],
};

const HYDROGEN_ACCEPTOR_MAP = {
  ASP: ["OD1", "OD2"],
  GLU: ["OE1", "OE2"],
  ASN: ["OD1"],
  GLN: ["OE1"],
  HIS: ["ND1", "NE2"],
  SER: ["OG"],
  THR: ["OG1"],
  TYR: ["OH"],
  CYS: ["SG"],
};

const POSITIVE_RESIDUE_ATOMS = {
  ARG: ["NE", "NH1", "NH2"],
  LYS: ["NZ"],
  HIS: ["ND1", "NE2"],
};

const NEGATIVE_RESIDUE_ATOMS = {
  ASP: ["OD1", "OD2"],
  GLU: ["OE1", "OE2"],
};

const INTERACTION_COLORS = {
  "Hydrogen Bond": 0x60a5fa,
  "Salt Bridge": 0xf97316,
  "Ionic Interaction": 0xa855f7,
  "Disulfide Bond": 0xfacc15,
};


playPauseButton.addEventListener("click", togglePlayPause);


backButton.addEventListener("click", moveBackward);
forwardButton.addEventListener("click", moveForward);

representationButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.getAttribute("data-representation");
    if (mode) {
      setRepresentationMode(mode);
    }
  });
});

function formatAngstroms(value) {
  return `${value.toFixed(1).replace(/\.0$/, "")}Å`;
}

function scheduleApplyResidueFilter(delay = FILTER_DEBOUNCE_MS) {
  if (applyFilterTimeout) {
    clearTimeout(applyFilterTimeout);
  }
  applyFilterTimeout = setTimeout(() => {
    applyFilterTimeout = null;
    applyResidueFilter();
  }, delay);
}

function updateProximityDisplay() {
  if (proximityValueEl) {
    proximityValueEl.textContent = formatAngstroms(proximityThreshold);
  }
  if (proximitySlider) {
    // Slider max is 10; clamp display to slider range
    const sliderMax = parseFloat(proximitySlider.max) || 10;
    const sliderVal = Math.min(proximityThreshold, sliderMax);
    const current = parseFloat(proximitySlider.value);
    if (!Number.isFinite(current) || Math.abs(current - sliderVal) > 0.05) {
      proximitySlider.value = String(sliderVal);
    }
  }
  const numInput = document.getElementById("proximity-number");
  if (numInput) {
    const numVal = parseFloat(numInput.value);
    if (!Number.isFinite(numVal) || Math.abs(numVal - proximityThreshold) > 0.05) {
      numInput.value = proximityThreshold.toFixed(1);
    }
  }
}

function setProximityThreshold(nextValue) {
  const parsed = Number.parseFloat(nextValue);
  if (!Number.isFinite(parsed)) return;
  const clamped = Math.min(20, Math.max(1, parsed));
  if (Math.abs(clamped - proximityThreshold) < 0.0001) return;
  proximityThreshold = clamped;
  updateProximityDisplay();
  scheduleApplyResidueFilter();
}

if (proximitySlider) {
  proximitySlider.addEventListener("input", (event) => {
    setProximityThreshold(event.target.value);
  });
  updateProximityDisplay();
} else if (proximityValueEl) {
  updateProximityDisplay();
}

// Numeric proximity input (allows up to 20Å, beyond slider max of 10)
const proximityNumberInput = document.getElementById("proximity-number");
if (proximityNumberInput) {
  proximityNumberInput.addEventListener("input", (event) => {
    setProximityThreshold(event.target.value);
  });
  proximityNumberInput.addEventListener("change", (event) => {
    setProximityThreshold(event.target.value);
  });
}

function handleDirectLoad(pdbId) {
  const trimmed = (pdbId || "").trim().toUpperCase();
  if (!trimmed) return;
  if (!/^[0-9A-Z]{4}$/.test(trimmed)) {
    SidePanel.announce(`"${pdbId}" is not a valid 4-character PDB ID.`);
    return;
  }
  if (stage) {
    stage.setSpin(null);
  }
  loadProteinStructure(trimmed);
}

if (pdbSearchButton) {
  pdbSearchButton.addEventListener("click", () => {
    const value = pdbSearchInput ? pdbSearchInput.value : "";
    handleDirectLoad(value);
  });
}

if (pdbSearchInput) {
  pdbSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleDirectLoad(pdbSearchInput.value);
    }
  });
}

// Help drawer toggle
(function () {
  const helpBtn = document.getElementById("help-toggle");
  const helpDrawer = document.getElementById("help-drawer");
  if (helpBtn && helpDrawer) {
    helpBtn.addEventListener("click", () => {
      helpDrawer.classList.toggle("is-open");
    });
  }
})();

updateRepresentationToggleState();

document.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  const tagName = event.target && event.target.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA") return;

  if (event.code === "Space") {
    event.preventDefault();
    togglePlayPause();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    moveForward();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveBackward();
  }
});

const analysisPanelEl = document.getElementById("analysis-panel");
const SidePanel = window.SidePanel;
if (!SidePanel || typeof SidePanel.init !== "function") {
  throw new Error("SidePanel namespace missing. Ensure sidepanel.js is loaded before proteinslideshow.js.");
}
SidePanel.init(analysisPanelEl);
dbg("SidePanel initialized");

let sidePanelSelection = new Set();

analysisPanelEl.addEventListener("sidepanel:residueSelected", (event) => {
  const detail = event.detail || {};
  const { selected, selectedResidues = [], accepted = true, reason } = detail;
  if (accepted === false) {
    if (reason === "limit") {
      setInteractionMessage("Max 10 residues.", "info-warning");
    } else if (reason === "disabled") {
      setInteractionMessage("No interactions for this residue.", "info-warning");
    }
    applyResidueFilter();
    return;
  }
  const selection = new Set(selectedResidues);
  handleSidePanelSelectionChange(selection, { focus: Boolean(selected) });
});
analysisPanelEl.addEventListener("sidepanel:analyze", () => {
  handleAnalyzeInteractions(sidePanelSelection);
});

if (toggleSpinButton) {
  toggleSpinButton.addEventListener("click", toggleSpin);
}
updateSpinControlUI();
updateSpinState();

// Stability Explorer controls
(function wireStabilityControls() {
  var stabilityToggle = document.getElementById("stability-toggle");
  var sweepSlider = document.getElementById("sweep-slider");
  var sweepPlayBtn = document.getElementById("sweep-play");
  var sweepResetBtn = document.getElementById("sweep-reset");
  var focusSelectionBtn = document.getElementById("focus-selection");

  if (stabilityToggle) {
    stabilityToggle.addEventListener("click", toggleStabilityMode);
  }
  if (sweepSlider) {
    sweepSlider.addEventListener("input", function (e) {
      stopSweep();
      sweepValue = parseFloat(e.target.value);
      updateSweepDisplay();
      updateSweepVisualization(sweepValue);
    });
  }
  if (sweepPlayBtn) {
    sweepPlayBtn.addEventListener("click", startSweep);
  }
  if (sweepResetBtn) {
    sweepResetBtn.addEventListener("click", resetSweep);
  }
  if (focusSelectionBtn) {
    focusSelectionBtn.addEventListener("click", function () {
      if (lastHighlightSelection) {
        scheduleFocus(lastHighlightSelection);
      }
    });
  }
})();

// ---------------------------------------------------------------------------
// Panel collapse / Zen mode / Resize handles
// ---------------------------------------------------------------------------
(function initPanelManagement() {
  const leftPanel = document.getElementById("left-panel");
  const rightPanel = document.getElementById("analysis-panel");
  const collapseBarLeft = document.getElementById("collapse-bar-left");
  const collapseBarRight = document.getElementById("collapse-bar-right");
  const resizeLeft = document.getElementById("resize-left");
  const resizeRight = document.getElementById("resize-right");
  const toggleLeftBtn = document.getElementById("toggle-left-panel");
  const toggleRightBtn = document.getElementById("toggle-right-panel");
  const zenBtn = document.getElementById("zen-mode");

  let leftCollapsed = false;
  let rightCollapsed = false;
  let zenMode = false;

  function setPanelState(side, collapsed) {
    const panel = side === "left" ? leftPanel : rightPanel;
    const bar = side === "left" ? collapseBarLeft : collapseBarRight;
    const handle = side === "left" ? resizeLeft : resizeRight;
    const btn = side === "left" ? toggleLeftBtn : toggleRightBtn;

    if (panel) panel.classList.toggle("is-collapsed", collapsed);
    if (bar) bar.hidden = !collapsed;
    if (handle) handle.hidden = collapsed;
    if (btn) btn.classList.toggle("is-active", !collapsed);

    if (side === "left") leftCollapsed = collapsed;
    else rightCollapsed = collapsed;

    // Let NGL know the viewport size changed
    requestAnimationFrame(function () {
      if (typeof stage !== "undefined" && stage && typeof stage.handleResize === "function") {
        stage.handleResize();
      }
    });
  }

  function toggleZen() {
    zenMode = !zenMode;
    setPanelState("left", zenMode ? true : false);
    setPanelState("right", zenMode ? true : false);
    if (zenBtn) zenBtn.classList.toggle("zen-active", zenMode);
  }

  // Panel header close buttons
  var collapseLeftBtn = document.getElementById("collapse-left");
  var collapseRightBtn = document.getElementById("collapse-right");
  if (collapseLeftBtn) collapseLeftBtn.addEventListener("click", function () { setPanelState("left", true); });
  if (collapseRightBtn) collapseRightBtn.addEventListener("click", function () { setPanelState("right", true); });

  // Collapse bar expand buttons
  var expandLeftBtn = document.getElementById("expand-left");
  var expandRightBtn = document.getElementById("expand-right");
  if (expandLeftBtn) expandLeftBtn.addEventListener("click", function () { setPanelState("left", false); });
  if (expandRightBtn) expandRightBtn.addEventListener("click", function () { setPanelState("right", false); });
  // Clicking the bar itself also expands
  if (collapseBarLeft) collapseBarLeft.addEventListener("click", function () { setPanelState("left", false); });
  if (collapseBarRight) collapseBarRight.addEventListener("click", function () { setPanelState("right", false); });

  // Header toggle buttons
  if (toggleLeftBtn) toggleLeftBtn.addEventListener("click", function () { setPanelState("left", !leftCollapsed); });
  if (toggleRightBtn) toggleRightBtn.addEventListener("click", function () { setPanelState("right", !rightCollapsed); });

  // Zen mode
  if (zenBtn) zenBtn.addEventListener("click", toggleZen);

  // Escape key toggles zen mode
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !(e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA"))) {
      toggleZen();
    }
  });

  // Resize handles (drag to resize panels)
  function initHandle(handleEl, panel, side) {
    if (!handleEl || !panel) return;
    handleEl.addEventListener("mousedown", function (e) {
      e.preventDefault();
      var startX = e.clientX;
      var startWidth = panel.getBoundingClientRect().width;
      handleEl.classList.add("is-dragging");

      function onMove(ev) {
        var dx = side === "left" ? ev.clientX - startX : startX - ev.clientX;
        var newWidth = Math.max(180, Math.min(500, startWidth + dx));
        panel.style.width = newWidth + "px";
        if (typeof stage !== "undefined" && stage && typeof stage.handleResize === "function") {
          stage.handleResize();
        }
      }

      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        handleEl.classList.remove("is-dragging");
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
  }

  initHandle(resizeLeft, leftPanel, "left");
  initHandle(resizeRight, rightPanel, "right");

  // Layout debug outlines (behind ?debug=1)
  if (DEBUG) {
    document.querySelector(".app-shell")?.classList.add("debug-outlines");
  }

  // Responsive: collapse left panel by default on medium screens
  if (window.innerWidth >= 800 && window.innerWidth < 1200) {
    setPanelState("left", true);
  }
})();

function moveForward() {
  stage.setSpin(null); // stop spinning
  if (!currentPdbIds || currentPdbIds.length === 0) {
    console.warn("No PDB IDs available when moving forward.");
    return;
  }
  currentIndex = (currentIndex + 1) % currentPdbIds.length;
  loadProteinStructure(currentPdbIds[currentIndex]);
}

function moveBackward() {
  stage.setSpin(null); // stop spinning
  if (!currentPdbIds || currentPdbIds.length === 0) {
    console.warn("No PDB IDs available when moving backward.");
    return;
  }
  currentIndex = (currentIndex - 1 + currentPdbIds.length) % currentPdbIds.length;
  loadProteinStructure(currentPdbIds[currentIndex]);
}

initSlideshow();
//intervalHandle = setInterval(moveForward, displayInterval);

function togglePlayPause() {
  isPaused = !isPaused;
  if (playPauseButton) playPauseButton.innerHTML = isPaused ? "&#x25B6;" : "&#x23F8;";
  if (isPaused) {
    clearInterval(intervalHandle);
  } else {
    intervalHandle = setInterval(moveForward, displayInterval);
  }
}

function setRepresentationMode(mode) {
  if (!representationConfigs[mode]) return;
  if (currentRepresentationMode === mode) return;
  currentRepresentationMode = mode;
  updateRepresentationToggleState();
  applyCurrentRepresentation();
}

function updateRepresentationToggleState() {
  representationButtons.forEach((button) => {
    const isActive = button.getAttribute("data-representation") === currentRepresentationMode;
    button.classList.toggle("is-active", isActive);
  });
}

function applyCurrentRepresentation(options = {}) {
  if (!currentComponent) return;

  if (options.rebuild) {
    rebuildRepresentationHandles(currentRepresentationMode);
  }

  ensureRepresentationHandles(currentRepresentationMode);

  if (!representationHandles[currentRepresentationMode] || representationHandles[currentRepresentationMode].length === 0) {
    if (currentRepresentationMode !== "cartoon") {
      console.warn(`Falling back to cartoon representation after ${currentRepresentationMode} failure.`);
      currentRepresentationMode = "cartoon";
      updateRepresentationToggleState();
      ensureRepresentationHandles(currentRepresentationMode);
    }
  }

  setRepresentationVisibility(currentRepresentationMode);
  updateSelectionHighlight(sidePanelSelection, { force: true });
  if (stage.viewer && typeof stage.viewer.requestRender === "function") {
    stage.viewer.requestRender();
  }
}

function clearInteractionVisuals() {
  if (interactionShapeComponent) {
    try {
      stage.removeComponent(interactionShapeComponent);
    } catch (err) {
      // component might already be removed as part of a stage reset
    }
    interactionShapeComponent = null;
  }
}

function ensureRepresentationHandles(mode) {
  if (!currentComponent || !mode) return;
  if (representationHandles[mode] && representationHandles[mode].length) return;

  const reps = [];
  const configs = representationConfigs[mode] || [];
  configs.forEach((config) => {
    try {
      const params = Object.assign({}, config.params || {});
      params.visible = mode === currentRepresentationMode;
      const rep = currentComponent.addRepresentation(config.type, params);
      reps.push(rep);
    } catch (err) {
      console.warn(`Failed to build ${mode} representation (${config.type})`, err);
    }
  });

  if (reps.length === 0 && mode === "cartoon") {
    try {
      reps.push(currentComponent.addRepresentation("cartoon", {
        sele: "polymer",
        colorScheme: "chainname",
        aspectRatio: 3,
        visible: mode === currentRepresentationMode,
      }));
    } catch (err) {
      console.warn("Failed to create fallback cartoon representation", err);
    }
  }

  representationHandles[mode] = reps;
}

function rebuildRepresentationHandles(mode) {
  if (!currentComponent || !mode) return;

  if (representationHandles[mode]) {
    representationHandles[mode].forEach((rep) => {
      if (rep && typeof rep.dispose === "function") {
        try {
          rep.dispose();
        } catch (err) {
          /* noop */
        }
      }
    });
    delete representationHandles[mode];
  }

  ensureRepresentationHandles(mode);
  setRepresentationVisibility(currentRepresentationMode);
  updateSelectionHighlight(sidePanelSelection, { force: true });
}

function setRepresentationVisibility(activeMode) {
  Object.entries(representationHandles).forEach(([mode, reps]) => {
    const isActive = mode === activeMode;
    reps.forEach((rep) => {
      if (rep && typeof rep.setVisibility === "function") {
        rep.setVisibility(isActive);
      }
    });
  });
}

function toggleSpin() {
  isSpinning = !isSpinning;
  updateSpinState();
}

function updateSpinState() {
  if (typeof stage.setSpin === "function") {
    if (isSpinning) {
      stage.setSpin([0, 1, 0]);
    } else {
      stage.setSpin(null);
    }
  }
  updateSpinControlUI();
}

function updateSpinControlUI() {
  if (!toggleSpinButton) return;
  toggleSpinButton.textContent = isSpinning ? "Stop" : "Spin";
  toggleSpinButton.classList.toggle("is-active", isSpinning);
}

function clearResidueVisuals() {
  selectedResidueVisuals.forEach((visuals) => {
    if (visuals.representation) {
      try {
        visuals.representation.dispose();
      } catch (err) {
        /* noop */
      }
    }
    if (visuals.label) {
      try {
        visuals.label.dispose();
      } catch (err) {
        /* noop */
      }
    }
  });
  selectedResidueVisuals.clear();
}

function removeResidueVisual(residueIndex) {
  const visuals = selectedResidueVisuals.get(residueIndex);
  if (!visuals) return;
  if (visuals.representation) {
    try {
      visuals.representation.dispose();
    } catch (err) {
      /* noop */
    }
  }
  if (visuals.label) {
    try {
      visuals.label.dispose();
    } catch (err) {
      /* noop */
    }
  }
  selectedResidueVisuals.delete(residueIndex);
}

function createResidueVisuals(residueData, color) {
  if (!currentComponent) return {};
  const sidechainSelection = `${residueData.selectionString} and sidechain`;
  const labelSelection = `${residueData.selectionString} and name CA`;

  const representation = currentComponent.addRepresentation("ball+stick", {
    sele: sidechainSelection,
    colorScheme: "uniform",
    colorValue: color,
    multipleBond: true,
    scale: 1.1,
    aspectRatio: 1.6,
  });

  const label = currentComponent.addRepresentation("label", {
    sele: labelSelection,
    color: color,
    labelType: "format",
    labelFormat: `${residueData.resname} ${residueData.chain}${residueData.resno}`,
    showBackground: true,
    backgroundColor: "rgba(15,23,42,0.85)",
    backgroundOpacity: 0.9,
    zOffset: 2.0,
  });

  return { representation, label };
}

function createResidueDataset(structure) {
  const residues = [];
  const map = new Map();

  structure.eachResidue((residue) => {
    if (!residue.isProtein()) return;
    const data = buildResidueData(structure, residue.index);
    map.set(data.key, data);
    residues.push(data);
  });

  residues.sort((a, b) => {
    if (a.chain === b.chain) return a.resno - b.resno;
    return a.chain.localeCompare(b.chain);
  });

  const contactMap = computeResidueContacts(structure, residues);
  return { list: residues, map, contactMap };
}

function computeResidueContacts(structure, residues) {
  const contactMap = new Map();

  residues.forEach((residue) => {
    contactMap.set(residue.key, new Map());
  });

  const atomProxyA = structure.getAtomProxy();
  const atomProxyB = structure.getAtomProxy();

  for (let i = 0; i < residues.length; i += 1) {
    for (let j = i + 1; j < residues.length; j += 1) {
      const resA = residues[i];
      const resB = residues[j];

      const atomsA = resA.sideChainAtoms.length ? resA.sideChainAtoms : resA.allAtomIndices;
      const atomsB = resB.sideChainAtoms.length ? resB.sideChainAtoms : resB.allAtomIndices;

      let minDistance = Infinity;
      for (let a = 0; a < atomsA.length; a += 1) {
        atomProxyA.index = atomsA[a];
        for (let b = 0; b < atomsB.length; b += 1) {
          atomProxyB.index = atomsB[b];
          const distance = atomProxyA.distanceTo(atomProxyB);
          if (distance < minDistance) {
            minDistance = distance;
          }
          if (minDistance <= CONTACT_DISTANCE_CUTOFF) break;
        }
        if (minDistance <= CONTACT_DISTANCE_CUTOFF) break;
      }

      if (minDistance <= CONTACT_DISTANCE_CUTOFF) {
        contactMap.get(resA.key).set(resB.key, minDistance);
        contactMap.get(resB.key).set(resA.key, minDistance);
      }
    }
  }

  return contactMap;
}


function makePairKey(keyA, keyB) {
  if (!keyA || !keyB) return `${keyA}|${keyB}`;
  return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
}

function hasInteractionBetween(residueA, residueB) {
  if (!residueA || !residueB) return false;
  const pairKey = makePairKey(residueA.key, residueB.key);
  if (interactionCache.has(pairKey)) {
    return interactionCache.get(pairKey);
  }

  const interactions = [];
  const involvedAtoms = new Set();
  analyzeResiduePair(residueA, residueB, interactions, involvedAtoms);
  const result = interactions.length > 0;
  interactionCache.set(pairKey, result);
  return result;
}


let lastProximityCount = 0;
let lastInteractionCount = 0;

function applyResidueFilter() {
  if (applyFilterTimeout) {
    clearTimeout(applyFilterTimeout);
    applyFilterTimeout = null;
  }
  const threshold = proximityThreshold || 5;

  if (!residueDataset.list.length) {
    lastProximityCount = 0;
    lastInteractionCount = 0;
    SidePanel.applyFilter(undefined, { proximity: new Set(), interaction: new Set(), threshold });
    updateSelectionCounts();
    return;
  }

  const selection = sidePanelSelection;
  const proximitySet = new Set();
  const interactionSet = new Set();

  if (selection.size > 0) {
    selection.forEach((key) => {
      const neighbors = residueDataset.contactMap.get(key);
      if (!neighbors) return;
      neighbors.forEach((distance, neighborKey) => {
        if (distance <= threshold) {
          proximitySet.add(neighborKey);
          const residueA = residueDataset.map.get(key);
          const residueB = residueDataset.map.get(neighborKey);
          if (residueA && residueB && hasInteractionBetween(residueA, residueB)) {
            interactionSet.add(neighborKey);
          }
        }
      });
    });
  }

  lastProximityCount = proximitySet.size;
  lastInteractionCount = interactionSet.size;

  // Option A: Selection is always allowed. Cutoff only controls highlighting.
  // Pass undefined for validResidues so no residues are disabled.
  SidePanel.applyFilter(undefined, { proximity: proximitySet, interaction: interactionSet, threshold });

  if (
    interactionResultsEl &&
    interactionResultsEl.dataset.state !== "results" &&
    selection.size > 0
  ) {
    if (interactionSet.size === 0) {
      const message = proximitySet.size === 0
        ? `No residues within ${formatAngstroms(threshold)}.`
        : "No interactions at this threshold.";
      setInteractionMessage(message, "info-warning");
      SidePanel.announce("No interactions available.");
    }
  }

  updateSelectionCounts();
}

function updateSelectionCounts() {
  const selEl = document.getElementById("count-selected");
  const proxEl = document.getElementById("count-proximity");
  const intEl = document.getElementById("count-interactions");

  const selCount = sidePanelSelection.size;
  if (selEl) {
    selEl.textContent = selCount + " sel";
    selEl.className = "cnt" + (selCount > 0 ? " cnt-active" : "");
  }
  if (proxEl) {
    proxEl.textContent = lastProximityCount + " near";
    proxEl.className = "cnt" + (lastProximityCount > 0 ? " cnt-prox-active" : "");
  }
  if (intEl) {
    intEl.textContent = lastInteractionCount + " int";
    intEl.className = "cnt" + (lastInteractionCount > 0 ? " cnt-int-active" : "");
  }
}

function scheduleFocus(selection) {
  if (!currentComponent || !selection) return;
  if (focusTimeout) {
    clearTimeout(focusTimeout);
  }
  focusTimeout = setTimeout(() => {
    try {
      currentComponent.autoView(selection, 500);
    } catch (err) {
      // ignore focus errors
    }
  }, 200);
}

function resetAnalysisUI(message = DEFAULT_ANALYSIS_MESSAGE) {
  sidePanelSelection = new Set();
  residueColorMap.clear();
  clearResidueVisuals();
  lastHighlightSelection = null;
  clearInteractionVisuals();
  residueDataset = { list: [], map: new Map(), contactMap: new Map() };
  interactionCache = new Map();
  hasAutoFocusedForStructure = false;
  // Reset stability explorer state
  stabilityMode = false;
  stabilityData = [];
  lastAnalyzedInteractions = [];
  sweepValue = SWEEP_MIN;
  stopSweep();
  const stabilityPanel = document.getElementById("stability-explorer");
  if (stabilityPanel) stabilityPanel.hidden = true;
  const stabilityToggle = document.getElementById("stability-toggle");
  if (stabilityToggle) {
    stabilityToggle.disabled = true;
    stabilityToggle.classList.remove("is-active");
  }
  lastProximityCount = 0;
  lastInteractionCount = 0;
  SidePanel.renderResidueList([]);
  SidePanel.updateSelections([]);
  SidePanel.applyFilter(undefined, { proximity: new Set(), interaction: new Set(), threshold: proximityThreshold });
  setInteractionMessage(message, "info-default");
  SidePanel.announce(message);
  updateSelectionCounts();
}

function setInteractionMessage(message, state = "info-default") {
  if (!interactionResultsEl) return;
  interactionResultsEl.textContent = message;
  interactionResultsEl.dataset.state = state;
}

function updateSidePanelResidues(structure) {
  if (!structure) {
    resetAnalysisUI("Load a structure first.");
    return;
  }

  const dataset = createResidueDataset(structure);
  residueDataset = dataset;
  interactionCache = new Map();
  sidePanelSelection = new Set();
  residueColorMap.clear();
  clearResidueVisuals();
  lastHighlightSelection = null;
  clearInteractionVisuals();
  hasAutoFocusedForStructure = false;

  if (!dataset.list.length) {
    resetAnalysisUI("No residues in this structure.");
    return;
  }

  SidePanel.renderResidueList(dataset.list);
  SidePanel.updateSelections([]);
  applyResidueFilter();
  setInteractionMessage(DEFAULT_ANALYSIS_MESSAGE, "info-default");
  SidePanel.announce(`${dataset.list.length} residues available for analysis.`);
}



function handleSidePanelSelectionChange(selectedSet = new Set(), { focus = false } = {}) {
  const selection = selectedSet instanceof Set ? new Set(selectedSet) : new Set(selectedSet);
  sidePanelSelection = selection;
  SidePanel.updateSelections(selection);
  updateSelectionHighlight(selection, { focusOn: focus });

  if (!selection.size) {
    setInteractionMessage(DEFAULT_ANALYSIS_MESSAGE, "info-default");
  } else if (selection.size < 2) {
    setInteractionMessage("Select at least 2 residues.", "info-default");
  } else if (selection.size > 10) {
    setInteractionMessage("Max 10 residues.", "info-warning");
  } else if (interactionResultsEl && interactionResultsEl.dataset.state === "results") {
    setInteractionMessage("Selection changed \u2014 re-analyze.", "info-dirty");
  }

  applyResidueFilter();

  // Enable/disable Stability Sweep based on selection count
  const stabilityToggle = document.getElementById("stability-toggle");
  if (stabilityToggle) {
    const enough = selection.size >= 2;
    stabilityToggle.disabled = !enough;
    stabilityToggle.title = enough
      ? "Shows which interactions persist as cutoff changes"
      : "Select 2+ residues to enable";
  }
}

function updateSelectionHighlight(selectedSet, { focusOn = false, force = false } = {}) {
  dbg("updateSelectionHighlight:", selectedSet ? selectedSet.size : 0, "residues, force:", force);
  if (!currentStructure || !currentComponent) {
    clearResidueVisuals();
    lastHighlightSelection = null;
    return;
  }

  if (force) {
    clearResidueVisuals();
  }

  const selectionSet = selectedSet ? new Set(selectedSet) : new Set();

  Array.from(selectedResidueVisuals.keys()).forEach((id) => {
    if (!selectionSet.has(id)) {
      removeResidueVisual(id);
    }
  });

  const selectionParts = [];

  selectionSet.forEach((id) => {
    const residueData = residueDataset.map.get(id);
    if (!residueData) return;

    if (!residueColorMap.has(id)) {
      residueColorMap.set(id, SELECTED_RESIDUE_COLOR);
    }

    if (!selectedResidueVisuals.has(id) || force) {
      const color = residueColorMap.get(id);
      const visuals = createResidueVisuals(residueData, color);
      selectedResidueVisuals.set(id, visuals);
    }

    selectionParts.push(residueData.selectionString);
  });

  lastHighlightSelection = selectionParts.length ? selectionParts.join(" OR ") : null;

  // Auto-focus only on first residue selection per structure.
  // Subsequent selections preserve the user's manual camera position.
  if (focusOn && lastHighlightSelection && !hasAutoFocusedForStructure) {
    scheduleFocus(lastHighlightSelection);
    hasAutoFocusedForStructure = true;
  }
}

function handleAnalyzeInteractions(selectedSet = sidePanelSelection) {
  if (!interactionResultsEl || !currentComponent) return;
  if (!currentStructure) {
    setInteractionMessage("Load a structure first.", "info-default");
    return;
  }

  const residueIds = Array.from(selectedSet || new Set());
  if (residueIds.length < 2 || residueIds.length > 10) {
    setInteractionMessage("Select 2\u201310 residues first.", "info-default");
    return;
  }

  const residueData = residueIds
    .map((id) => residueDataset.map.get(id))
    .filter(Boolean);

  if (residueData.length < 2) {
    setInteractionMessage("Cannot resolve residue data.", "info-warning");
    return;
  }

  const interactions = [];
  const involvedAtoms = new Set();

  for (let i = 0; i < residueData.length; i += 1) {
    for (let j = i + 1; j < residueData.length; j += 1) {
      analyzeResiduePair(residueData[i], residueData[j], interactions, involvedAtoms);
    }
  }

  lastAnalyzedInteractions = interactions;
  renderInteractionResults(residueData, interactions);
  updateInteractionVisuals(residueData, interactions, involvedAtoms);

  // If stability mode is already active, refresh stability data
  if (stabilityMode && interactions.length) {
    stabilityData = computeStabilityData(interactions);
    renderStabilityResults(stabilityData);
    updateSweepDisplay();
    updateSweepVisualization(sweepValue);
  }
}

async function loadProteinStructure(pdbId) {
  dbg("loadProteinStructure: start", pdbId);
  setStatus("Loading", "loading");
  const session = createLoadSession(pdbId);
  const myLoadToken = session.id;
  const modelNameEl = document.getElementById("model-name");
  if (modelNameEl) modelNameEl.textContent = pdbId;
  stage.removeAllComponents();
  currentComponent = null;
  currentStructure = null;
  resetAnalysisUI("Loading\u2026");

  updateMetadataPanel(pdbId, myLoadToken, session);

  const sources = [
    {
      label: "CIF (gzip)",
      url: `https://files.rcsb.org/download/${pdbId}.cif.gz`,
      fileExt: "cif.gz",
      parserExt: "cif",
      mime: "application/gzip",
    },
    {
      label: "CIF",
      url: `https://files.rcsb.org/download/${pdbId}.cif`,
      fileExt: "cif",
      parserExt: "cif",
      mime: "chemical/x-cif",
    },
    {
      label: "PDB",
      url: `https://files.rcsb.org/download/${pdbId}.pdb`,
      fileExt: "pdb",
      parserExt: "pdb",
      mime: "chemical/x-pdb",
    },
  ];

  let lastError = null;

  for (const source of sources) {
    if (modelNameEl) modelNameEl.textContent = `${pdbId} (loading...)`;
    dbg("loadProteinStructure: trying", source.label, source.url);
    try {
      const structureComponent = await fetchAndLoadStructure(pdbId, source, session);
      // If another load was started since we began, drop this stale component.
      if (myLoadToken !== structureRequestToken) {
        dbg("loadProteinStructure: stale session, discarding", pdbId);
        try {
          if (structureComponent && typeof structureComponent.remove === 'function') {
            structureComponent.remove();
          }
        } catch (remErr) {
          // ignore
        }
        return;
      }

      dbg("loadProteinStructure: loaded", pdbId, "via", source.label);
      currentComponent = structureComponent;
      currentStructure = structureComponent.structure;
      representationHandles = {};
      applyCurrentRepresentation({ rebuild: true });
      dbg("loadProteinStructure: representation applied, calling autoView");
      structureComponent.autoView();
      updateSpinState();
      logShownEntity(pdbId);
      if (modelNameEl) modelNameEl.textContent = pdbId;
      setStatus("Ready", "ready");
      try {
        updateSidePanelResidues(currentStructure);
        dbg("loadProteinStructure: side panel updated, residues:", residueDataset.list.length);
      } catch (panelError) {
        console.error(`Loaded ${pdbId} but side panel failed:`, panelError);
        resetAnalysisUI("Residue list unavailable.");
      }
      return; // success
    } catch (err) {
      lastError = err;
      dbg("loadProteinStructure: source failed", source.label, err.message);
    }
  }

  // All sources failed
  console.error(`Failed to load ${pdbId} from all sources.`, lastError);
  if (modelNameEl) modelNameEl.textContent = `${pdbId} (failed)`;
  setStatus("Error", "error");
  resetAnalysisUI("Load failed.");
  throw lastError || new Error(`All sources failed for ${pdbId}`);
}

async function fetchAndLoadStructure(pdbId, source, session) {
  const controller = new AbortController();
  if (session && Array.isArray(session.controllers)) {
    session.controllers.push(controller);
  }
  dbg("fetch:", source.url);
  const response = await fetch(source.url, { signal: controller.signal });
  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (/html|json|text\/html|application\/json/i.test(contentType)) {
    const body = await response.text().catch(() => "(unable to read body)");
    throw new Error(`Unexpected content-type ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  dbg("fetch: received", arrayBuffer.byteLength, "bytes for", source.label);
  const fileLike = makeFileLike(arrayBuffer, `${pdbId}.${source.fileExt}`, source.mime || "application/octet-stream");

  dbg("stage.loadFile:", pdbId, source.parserExt);
  return stage.loadFile(fileLike, {
    defaultRepresentation: false,
    ext: source.parserExt,
    name: `${pdbId}.${source.fileExt}`,
  });
}

function makeFileLike(arrayBuffer, filename, mime) {
  const blobParts = [arrayBuffer];
  try {
    if (typeof File === "function") {
      return new File(blobParts, filename, { type: mime });
    }
  } catch (err) {
    console.warn("File constructor failed, falling back to Blob", err);
  }

  const blob = new Blob(blobParts, { type: mime });
  try {
    Object.defineProperty(blob, "name", {
      value: filename,
      writable: true,
      configurable: true,
    });
  } catch (err) {
    blob.name = filename; // best effort fallback
  }
  return blob;
}

function updateMetadataPanel(pdbId, loadToken, session) {
  if (!metadataContentEl) return;
  const token = typeof loadToken === 'number' ? loadToken : ++metadataRequestToken;
  setMetadataMessage(`Loading details for ${escapeHtml(pdbId)}…`, "metadata-loading");

  // create an AbortController for this metadata fetch and attach it to the session
  const controller = new AbortController();
  if (session && Array.isArray(session.controllers)) session.controllers.push(controller);

  fetchEntryMetadata(pdbId, { signal: controller.signal })
    .then((metadata) => {
      if (token !== structureRequestToken) return; // stale request
      if (currentLoadSession && session && session.id !== currentLoadSession.id) return; // stale session
      dbg("metadata loaded for", pdbId);
      renderMetadata(metadata);
    })
    .catch((err) => {
      if (token !== structureRequestToken) return;
      if (err && err.name === 'AbortError') return;
      console.error(`Metadata fetch failed for ${pdbId}:`, err);
      setMetadataMessage("Metadata unavailable.", "metadata-error");
    });
}

function buildResidueData(structure, residueIndex) {
  const residue = structure.getResidueProxy(residueIndex);
  const atomIndicesByName = new Map();
  const sideChainAtoms = [];
  const allAtomIndices = [];

  residue.eachAtom((atom) => {
    const name = atom.atomname.trim().toUpperCase();
    if (!atomIndicesByName.has(name)) {
      atomIndicesByName.set(name, []);
    }
    atomIndicesByName.get(name).push(atom.index);
    if (!BACKBONE_ATOMS.has(name) && name[0] !== "H") {
      sideChainAtoms.push(atom.index);
    }
    allAtomIndices.push(atom.index);
  });

  if (sideChainAtoms.length === 0 && atomIndicesByName.has("CA")) {
    sideChainAtoms.push(...atomIndicesByName.get("CA"));
  }

  const chainName = residue.chainname || "";
  const key = `${chainName}${residue.resno}`;

  return {
    id: key,
    key,
    structure,
    residueIndex,
    resname: residue.resname.toUpperCase(),
    chain: residue.chainname,
    resno: residue.resno,
    label: `${residue.resname} ${residue.chainname}${residue.resno}`,
    atomIndicesByName,
    sideChainAtoms,
    allAtomIndices,
    selectionString: `:${residue.chainname}:${residue.resno}`,
  };
}

function analyzeResiduePair(resA, resB, interactions, involvedAtoms) {
  detectHydrogenBonds(resA, resB, interactions, involvedAtoms);
  detectHydrogenBonds(resB, resA, interactions, involvedAtoms);
  detectSaltAndIonicInteractions(resA, resB, interactions, involvedAtoms);
  detectSaltAndIonicInteractions(resB, resA, interactions, involvedAtoms);
  detectDisulfideBond(resA, resB, interactions, involvedAtoms);
}

function detectHydrogenBonds(donorResidue, acceptorResidue, interactions, involvedAtoms) {
  const donorNames = HYDROGEN_DONOR_MAP[donorResidue.resname];
  const acceptorNames = HYDROGEN_ACCEPTOR_MAP[acceptorResidue.resname];
  if (!donorNames || !acceptorNames) return;

  const donorAtoms = getAtomsByNames(donorResidue, donorNames);
  const acceptorAtoms = getAtomsByNames(acceptorResidue, acceptorNames);
  if (!donorAtoms.length || !acceptorAtoms.length) return;

  const donorProxy = donorResidue.structure.getAtomProxy();
  const acceptorProxy = acceptorResidue.structure.getAtomProxy();

  donorAtoms.forEach((dAtom) => {
    donorProxy.index = dAtom.index;
    acceptorAtoms.forEach((aAtom) => {
      acceptorProxy.index = aAtom.index;
      const distance = donorProxy.distanceTo(acceptorProxy);
      if (distance <= 3.5) {
        interactions.push({
          type: "Hydrogen Bond",
          description: `Hydrogen bond between ${donorResidue.label} ${dAtom.name} and ${acceptorResidue.label} ${aAtom.name} (${distance.toFixed(2)} Å)`,
          atomA: dAtom.index,
          atomB: aAtom.index,
          distance,
          residueALabel: donorResidue.label,
          residueBLabel: acceptorResidue.label,
          atomAName: dAtom.name,
          atomBName: aAtom.name,
        });
        involvedAtoms.add(dAtom.index);
        involvedAtoms.add(aAtom.index);
      }
    });
  });
}

function detectSaltAndIonicInteractions(resA, resB, interactions, involvedAtoms) {
  const positiveAtoms = getAtomsByNames(resA, POSITIVE_RESIDUE_ATOMS[resA.resname]);
  const negativeAtoms = getAtomsByNames(resB, NEGATIVE_RESIDUE_ATOMS[resB.resname]);
  if (!positiveAtoms.length || !negativeAtoms.length) return;

  const atomProxyA = resA.structure.getAtomProxy();
  const atomProxyB = resB.structure.getAtomProxy();

  positiveAtoms.forEach((posAtom) => {
    atomProxyA.index = posAtom.index;
    negativeAtoms.forEach((negAtom) => {
      atomProxyB.index = negAtom.index;
      const distance = atomProxyA.distanceTo(atomProxyB);
      if (distance <= 6.0) {
        const type = distance <= 4.0 ? "Salt Bridge" : "Ionic Interaction";
        interactions.push({
          type,
          description: `${type} between ${resA.label} ${posAtom.name} and ${resB.label} ${negAtom.name} (${distance.toFixed(2)} Å)`,
          atomA: posAtom.index,
          atomB: negAtom.index,
          distance,
          residueALabel: resA.label,
          residueBLabel: resB.label,
          atomAName: posAtom.name,
          atomBName: negAtom.name,
        });
        involvedAtoms.add(posAtom.index);
        involvedAtoms.add(negAtom.index);
      }
    });
  });
}

function detectDisulfideBond(resA, resB, interactions, involvedAtoms) {
  if (resA.resname !== "CYS" || resB.resname !== "CYS") return;
  const sgA = getAtomsByNames(resA, ["SG"]);
  const sgB = getAtomsByNames(resB, ["SG"]);
  if (!sgA.length || !sgB.length) return;

  const atomProxyA = resA.structure.getAtomProxy();
  const atomProxyB = resB.structure.getAtomProxy();
  atomProxyA.index = sgA[0].index;
  atomProxyB.index = sgB[0].index;
  const distance = atomProxyA.distanceTo(atomProxyB);
  if (distance <= 2.2) {
    interactions.push({
      type: "Disulfide Bond",
      description: `Disulfide bond between ${resA.label} SG and ${resB.label} SG (${distance.toFixed(2)} Å)`,
      atomA: sgA[0].index,
      atomB: sgB[0].index,
      distance,
      residueALabel: resA.label,
      residueBLabel: resB.label,
      atomAName: "SG",
      atomBName: "SG",
    });
    involvedAtoms.add(sgA[0].index);
    involvedAtoms.add(sgB[0].index);
  }
}

function getAtomsByNames(residueData, names = []) {
  if (!names || !names.length) return [];
  const atoms = [];
  names.forEach((name) => {
    const indices = residueData.atomIndicesByName.get(name);
    if (indices) {
      indices.forEach((index) => {
        atoms.push({ index, name });
      });
    }
  });
  return atoms;
}

// ---------------------------------------------------------------------------
// Cutoff-parameterized interaction detection for stability sweep.
// Unlike the standard detectors which use hardcoded cutoffs, these accept
// an explicit cutoff so we can re-detect at each sweep step.
// ---------------------------------------------------------------------------

function detectAllInteractionsAtCutoff(residueData, cutoff) {
  const interactions = [];
  for (let i = 0; i < residueData.length; i++) {
    for (let j = i + 1; j < residueData.length; j++) {
      detectPairAtCutoff(residueData[i], residueData[j], cutoff, interactions);
    }
  }
  return interactions;
}

function detectPairAtCutoff(resA, resB, cutoff, interactions) {
  // Hydrogen bonds (standard cutoff 3.5Å)
  if (cutoff >= 0) {
    detectHBondsAtCutoff(resA, resB, cutoff, interactions);
    detectHBondsAtCutoff(resB, resA, cutoff, interactions);
  }
  // Salt bridge / ionic (standard cutoff 4.0 / 6.0Å)
  detectChargedAtCutoff(resA, resB, cutoff, interactions);
  detectChargedAtCutoff(resB, resA, cutoff, interactions);
  // Disulfide (standard cutoff 2.2Å)
  detectDisulfideAtCutoff(resA, resB, cutoff, interactions);
}

function detectHBondsAtCutoff(donor, acceptor, cutoff, interactions) {
  const dNames = HYDROGEN_DONOR_MAP[donor.resname];
  const aNames = HYDROGEN_ACCEPTOR_MAP[acceptor.resname];
  if (!dNames || !aNames) return;
  const dAtoms = getAtomsByNames(donor, dNames);
  const aAtoms = getAtomsByNames(acceptor, aNames);
  if (!dAtoms.length || !aAtoms.length) return;
  const dp = donor.structure.getAtomProxy();
  const ap = acceptor.structure.getAtomProxy();
  dAtoms.forEach(function (d) {
    dp.index = d.index;
    aAtoms.forEach(function (a) {
      ap.index = a.index;
      var dist = dp.distanceTo(ap);
      if (dist <= cutoff) {
        interactions.push({
          type: "Hydrogen Bond",
          atomA: d.index, atomB: a.index, distance: dist,
          residueALabel: donor.label, residueBLabel: acceptor.label,
          atomAName: d.name, atomBName: a.name,
        });
      }
    });
  });
}

function detectChargedAtCutoff(resA, resB, cutoff, interactions) {
  var posNames = POSITIVE_RESIDUE_ATOMS[resA.resname];
  var negNames = NEGATIVE_RESIDUE_ATOMS[resB.resname];
  if (!posNames || !negNames) return;
  var posAtoms = getAtomsByNames(resA, posNames);
  var negAtoms = getAtomsByNames(resB, negNames);
  if (!posAtoms.length || !negAtoms.length) return;
  var pa = resA.structure.getAtomProxy();
  var pb = resB.structure.getAtomProxy();
  posAtoms.forEach(function (p) {
    pa.index = p.index;
    negAtoms.forEach(function (n) {
      pb.index = n.index;
      var dist = pa.distanceTo(pb);
      if (dist <= cutoff) {
        var type = dist <= Math.min(cutoff, 4.0) ? "Salt Bridge" : "Ionic Interaction";
        interactions.push({
          type: type,
          atomA: p.index, atomB: n.index, distance: dist,
          residueALabel: resA.label, residueBLabel: resB.label,
          atomAName: p.name, atomBName: n.name,
        });
      }
    });
  });
}

function detectDisulfideAtCutoff(resA, resB, cutoff, interactions) {
  if (resA.resname !== "CYS" || resB.resname !== "CYS") return;
  var sgA = getAtomsByNames(resA, ["SG"]);
  var sgB = getAtomsByNames(resB, ["SG"]);
  if (!sgA.length || !sgB.length) return;
  var pa = resA.structure.getAtomProxy();
  var pb = resB.structure.getAtomProxy();
  pa.index = sgA[0].index;
  pb.index = sgB[0].index;
  var dist = pa.distanceTo(pb);
  if (dist <= cutoff) {
    interactions.push({
      type: "Disulfide Bond",
      atomA: sgA[0].index, atomB: sgB[0].index, distance: dist,
      residueALabel: resA.label, residueBLabel: resB.label,
      atomAName: "SG", atomBName: "SG",
    });
  }
}

// Build a stable key for de-duplicating interactions across sweep steps
function interactionKey(ix) {
  var a = ix.residueALabel + ":" + (ix.atomAName || "");
  var b = ix.residueBLabel + ":" + (ix.atomBName || "");
  var pair = a < b ? a + "|" + b : b + "|" + a;
  return ix.type + "/" + pair;
}

// Run the full sweep: detect interactions at each cutoff step, track persistence
function runStabilitySweep(selectedResidueIds) {
  var residueData = selectedResidueIds
    .map(function (id) { return residueDataset.map.get(id); })
    .filter(Boolean);

  if (residueData.length < 2) return [];

  // Map: interactionKey → { type, residueALabel, residueBLabel, atomAName, atomBName, atomA, atomB, distance, firstSeen, lastSeen, stepCount }
  var seen = new Map();

  for (var cutoff = SWEEP_MIN; cutoff <= SWEEP_MAX + 0.001; cutoff += SWEEP_STEP) {
    var c = Math.round(cutoff * 10) / 10; // avoid floating point drift
    var hits = detectAllInteractionsAtCutoff(residueData, c);

    // De-duplicate within this step (same atom pair may appear from both directions)
    var stepKeys = new Set();
    hits.forEach(function (ix) {
      var key = interactionKey(ix);
      if (stepKeys.has(key)) return;
      stepKeys.add(key);

      if (!seen.has(key)) {
        seen.set(key, {
          type: ix.type,
          residueALabel: ix.residueALabel,
          residueBLabel: ix.residueBLabel,
          atomAName: ix.atomAName,
          atomBName: ix.atomBName,
          atomA: ix.atomA,
          atomB: ix.atomB,
          distance: ix.distance,
          firstSeen: c,
          lastSeen: c,
          stepCount: 0,
        });
      }
      var entry = seen.get(key);
      entry.lastSeen = c;
      entry.stepCount += 1;
    });
  }

  // Convert to array and compute span
  var results = [];
  seen.forEach(function (entry) {
    entry.span = Math.round((entry.lastSeen - entry.firstSeen) * 10) / 10;
    results.push(entry);
  });

  // Sort by span descending (most robust first)
  results.sort(function (a, b) { return b.span - a.span || a.firstSeen - b.firstSeen; });
  return results;
}

function renderInteractionResults(residueData, interactions) {
  if (!interactionResultsEl) return;
  if (!interactions.length) {
    interactionResultsEl.textContent = "No interactions detected at current thresholds.";
    interactionResultsEl.dataset.state = "info-empty";
    return;
  }

  const list = document.createElement("ul");
  interactions.forEach((interaction) => {
    const item = document.createElement("li");
    item.textContent = interaction.description;
    list.appendChild(item);
  });

  interactionResultsEl.innerHTML = "";
  interactionResultsEl.appendChild(list);
  interactionResultsEl.dataset.state = "results";
}

function updateInteractionVisuals(residueData, interactions, involvedAtoms) {
  clearInteractionVisuals();
  if (!currentComponent || !currentStructure) return;

  // Preserve existing selection highlights (pass current selection, not empty)
  updateSelectionHighlight(sidePanelSelection);

  if (!interactions.length) return;

  const shape = new NGL.Shape("sidechain-interactions");
  const atomProxyA = currentStructure.getAtomProxy();
  const atomProxyB = currentStructure.getAtomProxy();

  interactions.forEach((interaction) => {
    const color = INTERACTION_COLORS[interaction.type] || 0xffffff;
    atomProxyA.index = interaction.atomA;
    atomProxyB.index = interaction.atomB;
    const from = [atomProxyA.x, atomProxyA.y, atomProxyA.z];
    const to = [atomProxyB.x, atomProxyB.y, atomProxyB.z];
    shape.addCylinder(from, to, color, 0.15);
    shape.addSphere(from, color, 0.25);
    shape.addSphere(to, color, 0.25);
  });

  interactionShapeComponent = stage.addComponentFromObject(shape);
  interactionShapeComponent.addRepresentation("buffer");
}

// ---------------------------------------------------------------------------
// Interaction Stability Explorer
// Helps scientists answer: "Is this interaction robust, or an artifact of an
// arbitrary cutoff?" by sweeping a unified distance cutoff across the
// detection range and showing where each interaction appears/disappears.
// ---------------------------------------------------------------------------

function toggleStabilityMode() {
  stabilityMode = !stabilityMode;
  const panel = document.getElementById("stability-explorer");
  const toggle = document.getElementById("stability-toggle");
  if (panel) panel.hidden = !stabilityMode;
  if (toggle) toggle.classList.toggle("is-active", stabilityMode);

  if (stabilityMode) {
    // Run a real sweep using current selection
    dbg("Stability Sweep: starting with", sidePanelSelection.size, "residues");
    const selectedIds = Array.from(sidePanelSelection);
    if (selectedIds.length < 2) {
      stabilityData = [];
      const container = document.getElementById("stability-results");
      if (container) container.textContent = "Select 2+ residues first.";
      return;
    }

    const sweepResults = runStabilitySweep(selectedIds);
    dbg("Stability Sweep: found", sweepResults.length, "interactions across sweep range");

    // Convert sweep results to stabilityData format for visualization
    stabilityData = sweepResults.map(function (entry) {
      return Object.assign({}, entry, {
        appearsAt: entry.firstSeen,
        disappearsAt: entry.lastSeen,
        rangeWidth: entry.span,
        robustness: Math.max(0, Math.min(1, entry.span / (SWEEP_MAX - SWEEP_MIN))),
      });
    });

    renderStabilityResults(stabilityData);
    sweepValue = SWEEP_MIN;
    updateSweepDisplay();
    updateSweepVisualization(sweepValue);
  } else {
    stopSweep();
    stabilityData = [];
    // Restore normal interaction visuals
    if (lastAnalyzedInteractions.length) {
      rebuildInteractionShape(lastAnalyzedInteractions);
    }
  }
}

// Compute stability metadata for each interaction: where it appears and
// disappears on the distance-cutoff axis, plus a robustness score.
function computeStabilityData(interactions) {
  return interactions.map((interaction) => {
    const cutoff = TYPE_CUTOFFS[interaction.type] || 5.0;
    const appearsAt = interaction.distance;
    const disappearsAt = cutoff;
    const rangeWidth = Math.max(0, disappearsAt - appearsAt);
    const maxRange = SWEEP_MAX - SWEEP_MIN;
    const robustness = Math.max(0, Math.min(1, rangeWidth / maxRange));
    return Object.assign({}, interaction, {
      appearsAt,
      disappearsAt,
      rangeWidth,
      robustness,
    });
  });
}

function renderStabilityResults(data) {
  const container = document.getElementById("stability-results");
  if (!container) return;
  container.innerHTML = "";

  if (!data.length) {
    container.textContent = "0 interactions across sweep range " + SWEEP_MIN.toFixed(1) + "\u2013" + SWEEP_MAX.toFixed(1) + " \u00C5.";
    return;
  }

  const sorted = data.slice().sort(function (a, b) { return b.robustness - a.robustness; });

  // Summary table
  var table = document.createElement("table");
  table.className = "stability-table";
  var thead = document.createElement("thead");
  var headerRow = document.createElement("tr");
  ["Type", "Pair", "First \u00C5", "Last \u00C5", "Span"].forEach(function (h) {
    var th = document.createElement("th");
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  var tbody = document.createElement("tbody");
  sorted.forEach(function (entry) {
    var tr = document.createElement("tr");
    var typeShort = entry.type.replace("Hydrogen Bond", "H-bond")
      .replace("Salt Bridge", "Salt")
      .replace("Ionic Interaction", "Ionic")
      .replace("Disulfide Bond", "S\u2013S");
    var pair = entry.residueALabel + " \u2194 " + entry.residueBLabel;
    [typeShort, pair, entry.appearsAt.toFixed(1), entry.disappearsAt.toFixed(1), entry.rangeWidth.toFixed(1)].forEach(function (val, ci) {
      var td = document.createElement("td");
      td.textContent = val;
      if (ci === 0) {
        var color = INTERACTION_COLORS[entry.type] || 0xffffff;
        td.style.color = "#" + color.toString(16).padStart(6, "0");
        td.style.fontWeight = "600";
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  // Visual persistence bars below the table
  var barsWrap = document.createElement("div");
  barsWrap.style.marginTop = "8px";

  // Distance scale reference
  var scaleDiv = document.createElement("div");
  scaleDiv.className = "stability-scale";
  for (var v = Math.ceil(SWEEP_MIN); v <= SWEEP_MAX; v += 2) {
    var mark = document.createElement("span");
    mark.className = "stability-scale-mark";
    mark.style.left = ((v - SWEEP_MIN) / (SWEEP_MAX - SWEEP_MIN) * 100) + "%";
    mark.textContent = v + "\u00C5";
    scaleDiv.appendChild(mark);
  }
  barsWrap.appendChild(scaleDiv);

  sorted.forEach(function (entry) {
    var item = document.createElement("div");
    item.className = "stability-item";
    item.dataset.appearsAt = String(entry.appearsAt);
    item.dataset.disappearsAt = String(entry.disappearsAt);

    var label = document.createElement("div");
    label.className = "stability-label";
    var atomDetail = (entry.atomAName && entry.atomBName)
      ? " (" + entry.atomAName + "\u2013" + entry.atomBName + ")"
      : "";
    label.textContent = entry.type + ": " + entry.residueALabel + " \u2194 " + entry.residueBLabel + atomDetail;

    var bar = document.createElement("div");
    bar.className = "stability-bar";

    var fill = document.createElement("div");
    fill.className = "stability-bar-fill";
    var color = INTERACTION_COLORS[entry.type] || 0xffffff;
    var hex = "#" + color.toString(16).padStart(6, "0");
    fill.style.background = hex;
    var leftPct = Math.max(0, (entry.appearsAt - SWEEP_MIN) / (SWEEP_MAX - SWEEP_MIN) * 100);
    var widthPct = Math.max(1, entry.rangeWidth / (SWEEP_MAX - SWEEP_MIN) * 100);
    fill.style.left = leftPct + "%";
    fill.style.width = widthPct + "%";

    var cursor = document.createElement("div");
    cursor.className = "stability-bar-cursor";
    cursor.style.left = "0%";

    bar.appendChild(fill);
    bar.appendChild(cursor);

    item.appendChild(label);
    item.appendChild(bar);
    barsWrap.appendChild(item);
  });

  container.appendChild(barsWrap);
}

function updateSweepDisplay() {
  var valueEl = document.getElementById("sweep-value");
  var slider = document.getElementById("sweep-slider");
  if (valueEl) valueEl.textContent = sweepValue.toFixed(1) + "\u00C5";
  if (slider && Math.abs(parseFloat(slider.value) - sweepValue) > 0.05) {
    slider.value = String(sweepValue);
  }
}

// Rebuild the 3D interaction shape showing only interactions active at the
// current sweep cutoff. Called on each sweep step.
function updateSweepVisualization(value) {
  if (!stabilityMode || !stabilityData.length || !currentStructure || !currentComponent) return;

  clearInteractionVisuals();

  var shape = new NGL.Shape("stability-sweep");
  var atomProxyA = currentStructure.getAtomProxy();
  var atomProxyB = currentStructure.getAtomProxy();
  var hasVisible = false;

  stabilityData.forEach(function (entry) {
    var isActive = value >= entry.appearsAt && value <= entry.disappearsAt;
    if (isActive) {
      hasVisible = true;
      var color = INTERACTION_COLORS[entry.type] || 0xffffff;
      atomProxyA.index = entry.atomA;
      atomProxyB.index = entry.atomB;
      var from = [atomProxyA.x, atomProxyA.y, atomProxyA.z];
      var to = [atomProxyB.x, atomProxyB.y, atomProxyB.z];
      shape.addCylinder(from, to, color, 0.15);
      shape.addSphere(from, color, 0.25);
      shape.addSphere(to, color, 0.25);
    }
  });

  if (hasVisible) {
    interactionShapeComponent = stage.addComponentFromObject(shape);
    interactionShapeComponent.addRepresentation("buffer");
  }

  // Update sweep cursor position on all stability bars
  var pct = ((value - SWEEP_MIN) / (SWEEP_MAX - SWEEP_MIN)) * 100;
  document.querySelectorAll(".stability-bar-cursor").forEach(function (cursor) {
    cursor.style.left = pct + "%";
  });

  // Highlight/fade items based on whether the sweep includes them
  document.querySelectorAll(".stability-item").forEach(function (item) {
    var appears = parseFloat(item.dataset.appearsAt);
    var disappears = parseFloat(item.dataset.disappearsAt);
    var active = value >= appears && value <= disappears;
    item.classList.toggle("is-active", active);
    item.classList.toggle("is-faded", !active);
  });
}

// Rebuild the full interaction shape (used when exiting stability mode)
function rebuildInteractionShape(interactions) {
  clearInteractionVisuals();
  if (!currentComponent || !currentStructure || !interactions.length) return;

  var shape = new NGL.Shape("sidechain-interactions");
  var atomProxyA = currentStructure.getAtomProxy();
  var atomProxyB = currentStructure.getAtomProxy();

  interactions.forEach(function (interaction) {
    var color = INTERACTION_COLORS[interaction.type] || 0xffffff;
    atomProxyA.index = interaction.atomA;
    atomProxyB.index = interaction.atomB;
    var from = [atomProxyA.x, atomProxyA.y, atomProxyA.z];
    var to = [atomProxyB.x, atomProxyB.y, atomProxyB.z];
    shape.addCylinder(from, to, color, 0.15);
    shape.addSphere(from, color, 0.25);
    shape.addSphere(to, color, 0.25);
  });

  interactionShapeComponent = stage.addComponentFromObject(shape);
  interactionShapeComponent.addRepresentation("buffer");
}

function startSweep() {
  if (isSweeping) {
    stopSweep();
    return;
  }
  isSweeping = true;
  sweepValue = SWEEP_MIN;
  updateSweepDisplay();

  var playBtn = document.getElementById("sweep-play");
  if (playBtn) playBtn.textContent = "\u23F8 Pause";

  var lastTime = performance.now();

  function step(now) {
    if (!isSweeping || !stabilityMode) {
      stopSweep();
      return;
    }
    var dt = now - lastTime;
    lastTime = now;
    // Sweep at ~1.0 Å per second for a comfortable pace
    sweepValue += (dt / 1000) * 1.0;

    if (sweepValue >= SWEEP_MAX) {
      sweepValue = SWEEP_MAX;
      updateSweepDisplay();
      updateSweepVisualization(sweepValue);
      stopSweep();
      return;
    }

    updateSweepDisplay();
    updateSweepVisualization(sweepValue);
    sweepAnimationId = requestAnimationFrame(step);
  }

  sweepAnimationId = requestAnimationFrame(step);
}

function stopSweep() {
  isSweeping = false;
  if (sweepAnimationId) {
    cancelAnimationFrame(sweepAnimationId);
    sweepAnimationId = null;
  }
  var playBtn = document.getElementById("sweep-play");
  if (playBtn) playBtn.textContent = "\u25B6 Animate";
}

function resetSweep() {
  stopSweep();
  sweepValue = SWEEP_MIN;
  updateSweepDisplay();
  updateSweepVisualization(sweepValue);
}

// ---------------------------------------------------------------------------
// End Stability Explorer
// ---------------------------------------------------------------------------

async function fetchEntryMetadata(pdbId, options = {}) {
  const entryUrl = `https://data.rcsb.org/rest/v1/core/entry/${pdbId}`;
  const entryData = await fetchJson(entryUrl, `entry metadata for ${pdbId}`, options);

  let polymerData;
  const polymerIds = entryData?.rcsb_entry_container_identifiers?.polymer_entity_ids || [];
  if (polymerIds.length > 0) {
    const polymerUrl = `https://data.rcsb.org/rest/v1/core/polymer_entity/${pdbId}/${polymerIds[0]}`;
    try {
      polymerData = await fetchJson(polymerUrl, `polymer metadata for ${pdbId}`, options);
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      console.warn(`Unable to fetch polymer metadata for ${pdbId}:`, err);
    }
  }

  let assemblyData;
  const assemblyIds = entryData?.rcsb_entry_container_identifiers?.assembly_ids || [];
  if (assemblyIds.length > 0) {
    const assemblyUrl = `https://data.rcsb.org/rest/v1/core/assembly/${pdbId}/${assemblyIds[0]}`;
    try {
      assemblyData = await fetchJson(assemblyUrl, `assembly metadata for ${pdbId}`, options);
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      console.warn(`Unable to fetch assembly metadata for ${pdbId}:`, err);
    }
  }

  const chainIds = polymerData?.entity_poly?.pdbx_strand_id
    ? polymerData.entity_poly.pdbx_strand_id.split(/[,\s]+/).filter(Boolean)
    : [];

  const annotations = (polymerData?.rcsb_polymer_entity_annotation || [])
    .filter((entry) => entry?.name)
    .filter((entry, index, array) => array.findIndex((item) => item.name === entry.name) === index)
    .slice(0, 5)
    .map((entry) => ({
      name: entry.name,
      type: entry.type || entry.provenance_source || null,
    }));

  return {
    id: pdbId,
    title: entryData?.struct?.title || null,
    method: entryData?.rcsb_entry_info?.experimental_method || null,
    resolution: Array.isArray(entryData?.rcsb_entry_info?.resolution_combined)
      ? entryData.rcsb_entry_info.resolution_combined[0]
      : null,
    depositionDate: entryData?.rcsb_accession_info?.deposit_date || null,
    releaseDate: entryData?.rcsb_accession_info?.initial_release_date || null,
    molecularWeight: entryData?.rcsb_entry_info?.molecular_weight || null,
    polymerCount: entryData?.rcsb_entry_info?.polymer_entity_count || null,
    polymerInstanceCount:
      assemblyData?.rcsb_assembly_info?.polymer_entity_instance_count || null,
    polymerName: polymerData?.rcsb_polymer_entity?.pdbx_description
      || polymerData?.rcsb_polymer_entity?.rcsb_macromolecular_names_combined?.[0]?.name
      || polymerData?.entity_poly?.pdbx_description
      || null,
    organism: polymerData?.rcsb_entity_source_organism?.[0]?.scientific_name
      || polymerData?.entity_src_gen?.[0]?.pdbx_gene_src_scientific_name
      || null,
    citation: entryData?.rcsb_primary_citation || null,
    assembly: {
      oligomericDetails:
        assemblyData?.pdbx_struct_assembly?.oligomeric_details
        || assemblyData?.rcsb_struct_symmetry?.[0]?.oligomeric_state
        || null,
      symmetry: assemblyData?.rcsb_struct_symmetry?.[0]?.symbol || null,
    },
    chains: chainIds,
    annotations,
    thumbnail: `https://cdn.rcsb.org/images/structures/${pdbId.toLowerCase()}_assembly-1.jpeg`,
  };
}

async function fetchJson(url, label, options = {}) {
  const fetchOpts = {};
  if (options.signal) fetchOpts.signal = options.signal;
  const response = await fetch(url, fetchOpts);
  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`HTTP ${response.status} ${response.statusText} when fetching ${label}: ${body}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    const body = await response.text().catch(() => "(unable to read body)");
    throw new Error(`Expected JSON for ${label}, received ${contentType}: ${body}`);
  }

  return response.json();
}

function renderMetadata(metadata) {
  if (!metadataContentEl) return;

  metadataContentEl.innerHTML = "";

  if (metadata.thumbnail) {
    const figure = document.createElement("figure");
    figure.className = "metadata-figure";
    const img = document.createElement("img");
    img.src = metadata.thumbnail;
    img.alt = `Assembly preview for ${metadata.id}`;
    img.loading = "lazy";
    img.addEventListener("error", () => figure.remove());
    figure.appendChild(img);
    metadataContentEl.appendChild(figure);
  }

  if (metadata.title) {
    const headline = document.createElement("div");
    headline.className = "metadata-headline";
    headline.textContent = metadata.title;
    metadataContentEl.appendChild(headline);
  }

  const detailRows = [
    { label: "Method", value: metadata.method },
    { label: "Resolution", value: formatResolution(metadata.resolution) },
    { label: "Assembly", value: formatAssembly(metadata) },
    { label: "Symmetry", value: metadata.assembly?.symmetry },
    { label: "Chains", value: formatChains(metadata.chains) },
    { label: "Polymers", value: formatPolymerCounts(metadata) },
    { label: "Macromolecule", value: metadata.polymerName },
    { label: "Weight", value: formatMolecularWeight(metadata.molecularWeight) },
    { label: "Released", value: formatDate(metadata.releaseDate) },
    { label: "Deposited", value: formatDate(metadata.depositionDate) },
    { label: "Organism", value: metadata.organism },
  ].filter((row) => row.value && row.value !== "—");

  if (detailRows.length) {
    const list = document.createElement("dl");
    list.className = "metadata-grid";
    detailRows.forEach((row) => {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = row.value;
      list.appendChild(dt);
      list.appendChild(dd);
    });
    metadataContentEl.appendChild(list);
  } else {
    const empty = document.createElement("div");
    empty.className = "metadata-placeholder";
    empty.textContent = "No supplemental metadata available for this entry.";
    metadataContentEl.appendChild(empty);
  }

  if (metadata.annotations && metadata.annotations.length) {
    const tags = document.createElement("div");
    tags.className = "metadata-tags";
    metadata.annotations.forEach((annotation) => {
      const tag = document.createElement("span");
      tag.className = "metadata-tag";
      tag.textContent = annotation.name;
      tags.appendChild(tag);
    });
    metadataContentEl.appendChild(tags);
  }

  const citationElement = renderCitation(metadata.citation);
  if (citationElement) {
    metadataContentEl.appendChild(citationElement);
  }
}

function renderCitation(citation) {
  if (!citation) return null;

  const parts = [];
  if (citation.rcsb_journal_abbrev || citation.journal_abbrev) {
    parts.push(citation.rcsb_journal_abbrev || citation.journal_abbrev);
  }
  if (citation.year) {
    parts.push(String(citation.year));
  }

  const doi = citation.pdbx_database_id_doi;
  const container = document.createElement("p");
  container.className = "metadata-reference";
  container.textContent = citation.title || "Primary literature reference";

  const journalPart = parts.join(" · ").trim();
  const doiUrl = doi ? `https://doi.org/${encodeURIComponent(doi)}` : null;

  if (journalPart || doiUrl) {
    const br = document.createElement("br");
    container.appendChild(br);
    if (journalPart) {
      const span = document.createElement("span");
      span.textContent = journalPart;
      container.appendChild(span);
    }
    if (journalPart && doiUrl) {
      container.appendChild(document.createTextNode(" · "));
    }
    if (doiUrl) {
      const link = document.createElement("a");
      link.href = doiUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "DOI";
      container.appendChild(link);
    }
  }

  return container;
}

function setMetadataMessage(message, className) {
  if (!metadataContentEl) return;
  metadataContentEl.innerHTML = `<div class="${className}">${escapeHtml(message)}</div>`;
}

function formatResolution(value) {
  if (typeof value !== "number") return "—";
  return `${value.toFixed(2)} Å`;
}

function formatMolecularWeight(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `${value.toFixed(2)} kDa`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatChains(chains) {
  if (!Array.isArray(chains) || chains.length === 0) return null;
  return chains.join(", ");
}

function formatAssembly(metadata) {
  const descriptor = metadata.assembly?.oligomericDetails;
  const count = metadata.polymerInstanceCount;
  if (!descriptor && !count) return null;
  if (descriptor && count) {
    const suffix = count === 1 ? "chain" : "chains";
    return `${descriptor} (${count} ${suffix})`;
  }
  if (descriptor) return descriptor;
  if (count) {
    const suffix = count === 1 ? "chain" : "chains";
    return `${count} ${suffix}`;
  }
  return null;
}

function formatPolymerCounts(metadata) {
  const parts = [];
  if (typeof metadata.polymerCount === "number") {
    parts.push(`${metadata.polymerCount} entit${metadata.polymerCount === 1 ? "y" : "ies"}`);
  }
  if (typeof metadata.polymerInstanceCount === "number" && metadata.polymerInstanceCount !== metadata.polymerCount) {
    parts.push(`${metadata.polymerInstanceCount} instance${metadata.polymerInstanceCount === 1 ? "" : "s"}`);
  }
  if (!parts.length) return null;
  return parts.join(" · ");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
