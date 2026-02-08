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
const SWEEP_DEFAULT_STEP = 0.5;
const SWEEP_MAX_STEPS = 60; // Cap to avoid excessive computation

// Dynamic sweep max: coupled to proximity cutoff
function getSweepMax() { return proximityThreshold; }
function getSweepStep() {
  var range = getSweepMax() - SWEEP_MIN;
  if (range <= 0) return SWEEP_DEFAULT_STEP;
  var steps = Math.ceil(range / SWEEP_DEFAULT_STEP);
  if (steps <= SWEEP_MAX_STEPS) return SWEEP_DEFAULT_STEP;
  // Increase step to stay within budget
  return Math.round((range / SWEEP_MAX_STEPS) * 10) / 10;
}

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
// Cache: cutoff → interaction[] built during sweep run
let sweepStepCache = new Map();

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
  // If stability mode is active, re-run sweep with updated range
  if (stabilityMode) {
    syncSweepSlider();
  }
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

  // Use shared detector with default per-type cutoffs
  var result = computeInteractions([residueA, residueB], null);
  var found = result.interactions.length > 0;
  interactionCache.set(pairKey, found);
  return found;
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
  sweepStepCache = new Map();
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

  var scope = getAnalysisScope();
  dbg("Analyze: scope", scope.selectedIds.length, "residues,", scope.pairs.length, "pairs");

  if (scope.selectedIds.length < 2 || scope.selectedIds.length > 10) {
    setInteractionMessage("Select 2\u201310 residues first.", "info-default");
    return;
  }
  if (scope.residueData.length < 2) {
    setInteractionMessage("Cannot resolve residue data.", "info-warning");
    return;
  }

  // Use shared detector with default per-type cutoffs (cutoff=null)
  var result = computeInteractions(scope.residueData, null);
  var interactions = deduplicateInteractions(result.interactions);
  var involvedAtoms = result.involvedAtoms;

  dbg("Analyze: found", interactions.length, "interactions");

  lastAnalyzedInteractions = interactions;
  renderInteractionResults(scope.residueData, interactions);
  updateInteractionVisuals(scope.residueData, interactions, involvedAtoms);

  // If stability mode is already active, refresh
  if (stabilityMode) {
    runAndRenderStabilitySweep();
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
// Shared interaction detection pipeline.
// Both Analyze and Stability Sweep use these functions.
// ---------------------------------------------------------------------------

// Returns the analysis scope from current UI state.
function getAnalysisScope() {
  var selectedIds = Array.from(sidePanelSelection);
  var residueData = selectedIds
    .map(function (id) { return residueDataset.map.get(id); })
    .filter(Boolean);
  var pairs = [];
  for (var i = 0; i < residueData.length; i++) {
    for (var j = i + 1; j < residueData.length; j++) {
      pairs.push([residueData[i], residueData[j]]);
    }
  }
  return {
    selectedIds: selectedIds,
    residueData: residueData,
    pairs: pairs,
  };
}

// Build a stable key for de-duplicating interactions.
function interactionKey(ix) {
  var a = ix.residueALabel + ":" + (ix.atomAName || "");
  var b = ix.residueBLabel + ":" + (ix.atomBName || "");
  var pair = a < b ? a + "|" + b : b + "|" + a;
  return ix.type + "/" + pair;
}

// Core interaction detector. Accepts a cutoff override.
// When cutoff is null/undefined, uses per-type defaults (TYPE_CUTOFFS).
// Returns { interactions: [], involvedAtoms: Set }
function computeInteractions(residueData, cutoff) {
  var useDefault = (cutoff == null);
  var interactions = [];
  var involvedAtoms = new Set();

  for (var i = 0; i < residueData.length; i++) {
    for (var j = i + 1; j < residueData.length; j++) {
      var resA = residueData[i];
      var resB = residueData[j];
      // H-bonds (both directions)
      detectHBonds(resA, resB, useDefault ? TYPE_CUTOFFS["Hydrogen Bond"] : cutoff, interactions, involvedAtoms);
      detectHBonds(resB, resA, useDefault ? TYPE_CUTOFFS["Hydrogen Bond"] : cutoff, interactions, involvedAtoms);
      // Charged (salt bridge / ionic, both directions)
      detectCharged(resA, resB, useDefault ? TYPE_CUTOFFS["Ionic Interaction"] : cutoff, interactions, involvedAtoms);
      detectCharged(resB, resA, useDefault ? TYPE_CUTOFFS["Ionic Interaction"] : cutoff, interactions, involvedAtoms);
      // Disulfide
      detectDisulfide(resA, resB, useDefault ? TYPE_CUTOFFS["Disulfide Bond"] : cutoff, interactions, involvedAtoms);
    }
  }
  return { interactions: interactions, involvedAtoms: involvedAtoms };
}

function detectHBonds(donor, acceptor, cutoff, interactions, involvedAtoms) {
  var dNames = HYDROGEN_DONOR_MAP[donor.resname];
  var aNames = HYDROGEN_ACCEPTOR_MAP[acceptor.resname];
  if (!dNames || !aNames) return;
  var dAtoms = getAtomsByNames(donor, dNames);
  var aAtoms = getAtomsByNames(acceptor, aNames);
  if (!dAtoms.length || !aAtoms.length) return;
  var dp = donor.structure.getAtomProxy();
  var ap = acceptor.structure.getAtomProxy();
  dAtoms.forEach(function (d) {
    dp.index = d.index;
    aAtoms.forEach(function (a) {
      ap.index = a.index;
      var dist = dp.distanceTo(ap);
      if (dist <= cutoff) {
        interactions.push({
          type: "Hydrogen Bond",
          description: "Hydrogen bond between " + donor.label + " " + d.name + " and " + acceptor.label + " " + a.name + " (" + dist.toFixed(2) + " \u00C5)",
          atomA: d.index, atomB: a.index, distance: dist,
          residueALabel: donor.label, residueBLabel: acceptor.label,
          atomAName: d.name, atomBName: a.name,
        });
        involvedAtoms.add(d.index);
        involvedAtoms.add(a.index);
      }
    });
  });
}

function detectCharged(resA, resB, cutoff, interactions, involvedAtoms) {
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
        var type = dist <= 4.0 ? "Salt Bridge" : "Ionic Interaction";
        var desc = type + " between " + resA.label + " " + p.name + " and " + resB.label + " " + n.name + " (" + dist.toFixed(2) + " \u00C5)";
        interactions.push({
          type: type,
          description: desc,
          atomA: p.index, atomB: n.index, distance: dist,
          residueALabel: resA.label, residueBLabel: resB.label,
          atomAName: p.name, atomBName: n.name,
        });
        involvedAtoms.add(p.index);
        involvedAtoms.add(n.index);
      }
    });
  });
}

function detectDisulfide(resA, resB, cutoff, interactions, involvedAtoms) {
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
      description: "Disulfide bond between " + resA.label + " SG and " + resB.label + " SG (" + dist.toFixed(2) + " \u00C5)",
      atomA: sgA[0].index, atomB: sgB[0].index, distance: dist,
      residueALabel: resA.label, residueBLabel: resB.label,
      atomAName: "SG", atomBName: "SG",
    });
    involvedAtoms.add(sgA[0].index);
    involvedAtoms.add(sgB[0].index);
  }
}

// De-duplicate interactions (same atom pair from both detection directions)
function deduplicateInteractions(interactions) {
  var seen = new Set();
  return interactions.filter(function (ix) {
    var key = interactionKey(ix);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Run the full sweep: detect interactions at each cutoff step, track persistence.
// Also populates sweepStepCache for Animate playback.
function runStabilitySweep(scope) {
  var residueData = scope.residueData;
  if (residueData.length < 2) return [];

  var sweepMax = getSweepMax();
  var step = getSweepStep();
  dbg("Stability Sweep: range", SWEEP_MIN, "\u2013", sweepMax, "\u00C5, step", step,
    "\u00C5, residues:", residueData.length, "pairs:", scope.pairs.length);

  sweepStepCache = new Map();

  // Map: interactionKey → persistence record
  var seen = new Map();

  for (var cutoff = SWEEP_MIN; cutoff <= sweepMax + 0.001; cutoff += step) {
    var c = Math.round(cutoff * 10) / 10; // avoid floating point drift
    var result = computeInteractions(residueData, c);
    var deduped = deduplicateInteractions(result.interactions);

    // Cache this step for Animate playback
    sweepStepCache.set(c, deduped);

    deduped.forEach(function (ix) {
      var key = interactionKey(ix);
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

    dbg("  cutoff", c, "\u00C5 \u2192", deduped.length, "interactions");
  }

  // Convert to array and compute span
  var results = [];
  seen.forEach(function (entry) {
    entry.span = Math.round((entry.lastSeen - entry.firstSeen) * 10) / 10;
    results.push(entry);
  });

  // Sort by span descending (most robust first)
  results.sort(function (a, b) { return b.span - a.span || a.firstSeen - b.firstSeen; });

  dbg("Stability Sweep: total unique interactions:", results.length);
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
  var panel = document.getElementById("stability-explorer");
  var toggle = document.getElementById("stability-toggle");
  if (panel) panel.hidden = !stabilityMode;
  if (toggle) toggle.classList.toggle("is-active", stabilityMode);

  if (stabilityMode) {
    runAndRenderStabilitySweep();
  } else {
    stopSweep();
    stabilityData = [];
    sweepStepCache = new Map();
    // Restore normal interaction visuals
    if (lastAnalyzedInteractions.length) {
      rebuildInteractionShape(lastAnalyzedInteractions);
    }
  }
}

// Central function: run sweep, render results, update viewer.
// Called on toggle-on, and when Analyze is re-run while sweep is active.
function runAndRenderStabilitySweep() {
  var scope = getAnalysisScope();
  var container = document.getElementById("stability-results");

  if (scope.selectedIds.length < 2) {
    stabilityData = [];
    if (container) container.textContent = "Select 2+ residues.";
    return;
  }
  if (scope.residueData.length < 2) {
    stabilityData = [];
    if (container) container.textContent = "Cannot resolve residue data.";
    return;
  }
  if (scope.pairs.length === 0) {
    stabilityData = [];
    if (container) container.textContent = "No candidate pairs in scope.";
    return;
  }

  var sweepMax = getSweepMax();
  var step = getSweepStep();

  // Sync sweep slider to current range
  syncSweepSlider();

  var sweepResults = runStabilitySweep(scope);

  if (sweepResults.length === 0) {
    stabilityData = [];
    if (container) {
      container.textContent = "No typed interactions found (" + SWEEP_MIN.toFixed(1) + "\u2013" + sweepMax.toFixed(1) + " \u00C5, step " + step.toFixed(1) + " \u00C5). Only H-bond, salt bridge, ionic, and disulfide types are detected.";
    }

    // Debug: verify against Analyze at default cutoffs
    if (DEBUG) {
      var analyzeResult = computeInteractions(scope.residueData, null);
      var analyzeDeduped = deduplicateInteractions(analyzeResult.interactions);
      if (analyzeDeduped.length > 0) {
        console.warn("[DBG] Sweep found 0 but Analyze finds", analyzeDeduped.length,
          "at default cutoffs. Check if sweep max (" + sweepMax + ") covers the type cutoffs.");
      }
    }
    return;
  }

  // Convert to stability data format
  var range = sweepMax - SWEEP_MIN;
  stabilityData = sweepResults.map(function (entry) {
    return Object.assign({}, entry, {
      appearsAt: entry.firstSeen,
      disappearsAt: entry.lastSeen,
      rangeWidth: entry.span,
      robustness: range > 0 ? Math.max(0, Math.min(1, entry.span / range)) : 0,
    });
  });

  renderStabilityResults(stabilityData);
  sweepValue = SWEEP_MIN;
  updateSweepDisplay();
  updateSweepVisualization(sweepValue);
}

// Sync sweep slider range and info text to current proximity cutoff
function syncSweepSlider() {
  var sweepMax = getSweepMax();
  var step = getSweepStep();
  var slider = document.getElementById("sweep-slider");
  if (slider) {
    slider.min = String(SWEEP_MIN);
    slider.max = String(sweepMax);
    slider.step = "0.1";
  }
  var infoEl = document.getElementById("sweep-range-info");
  if (infoEl) {
    var stepCount = Math.ceil((sweepMax - SWEEP_MIN) / step);
    infoEl.textContent = "Sweep: " + SWEEP_MIN.toFixed(1) + "\u2013" + sweepMax.toFixed(1) + " \u00C5 (step " + step.toFixed(1) + " \u00C5, " + stepCount + " steps)";
  }
}

function renderStabilityResults(data) {
  var container = document.getElementById("stability-results");
  if (!container) return;
  container.innerHTML = "";

  if (!data.length) {
    container.textContent = "No interactions found.";
    return;
  }

  var sweepMax = getSweepMax();
  var range = sweepMax - SWEEP_MIN;

  var sorted = data.slice().sort(function (a, b) { return b.robustness - a.robustness; });

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
  var scaleStep = range <= 10 ? 2 : (range <= 30 ? 5 : 10);
  for (var v = Math.ceil(SWEEP_MIN); v <= sweepMax; v += scaleStep) {
    var mark = document.createElement("span");
    mark.className = "stability-scale-mark";
    mark.style.left = (range > 0 ? (v - SWEEP_MIN) / range * 100 : 0) + "%";
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
    var leftPct = range > 0 ? Math.max(0, (entry.appearsAt - SWEEP_MIN) / range * 100) : 0;
    var widthPct = range > 0 ? Math.max(1, entry.rangeWidth / range * 100) : 100;
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
  var sweepMax = getSweepMax();
  var valueEl = document.getElementById("sweep-value");
  var slider = document.getElementById("sweep-slider");
  if (valueEl) valueEl.textContent = sweepValue.toFixed(1) + "\u00C5";
  if (slider && Math.abs(parseFloat(slider.value) - sweepValue) > 0.05) {
    slider.value = String(sweepValue);
  }
}

// Update 3D viewer to show interactions at the current sweep cutoff.
// Uses cached per-step results when available; otherwise falls back to
// checking which stabilityData entries span the value.
function updateSweepVisualization(value) {
  if (!stabilityMode || !currentStructure || !currentComponent) return;

  clearInteractionVisuals();

  // Find the closest cached step
  var interactions = getInteractionsAtSweepValue(value);

  if (interactions && interactions.length > 0) {
    var shape = new NGL.Shape("stability-sweep");
    var atomProxyA = currentStructure.getAtomProxy();
    var atomProxyB = currentStructure.getAtomProxy();

    interactions.forEach(function (ix) {
      var color = INTERACTION_COLORS[ix.type] || 0xffffff;
      atomProxyA.index = ix.atomA;
      atomProxyB.index = ix.atomB;
      var from = [atomProxyA.x, atomProxyA.y, atomProxyA.z];
      var to = [atomProxyB.x, atomProxyB.y, atomProxyB.z];
      shape.addCylinder(from, to, color, 0.15);
      shape.addSphere(from, color, 0.25);
      shape.addSphere(to, color, 0.25);
    });

    interactionShapeComponent = stage.addComponentFromObject(shape);
    interactionShapeComponent.addRepresentation("buffer");
  }

  // Update sweep cursor position on all stability bars
  var sweepMax = getSweepMax();
  var range = sweepMax - SWEEP_MIN;
  var pct = range > 0 ? ((value - SWEEP_MIN) / range) * 100 : 0;
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

// Look up interactions at a sweep value from the step cache.
// Finds the closest cached step at or below the value.
function getInteractionsAtSweepValue(value) {
  if (sweepStepCache.size === 0) return [];
  // Round to one decimal
  var rounded = Math.round(value * 10) / 10;
  if (sweepStepCache.has(rounded)) return sweepStepCache.get(rounded);
  // Find closest step <= value
  var best = null;
  sweepStepCache.forEach(function (interactions, cutoff) {
    if (cutoff <= value + 0.001 && (best === null || cutoff > best)) {
      best = cutoff;
    }
  });
  return best !== null ? sweepStepCache.get(best) : [];
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

  // Disable Analyze during animation to avoid conflicting renders
  var analyzeBtn = document.getElementById("analyze-interactions");
  if (analyzeBtn) analyzeBtn.disabled = true;

  var playBtn = document.getElementById("sweep-play");
  if (playBtn) playBtn.textContent = "\u23F8 Pause";

  var sweepMax = getSweepMax();
  var lastTime = performance.now();

  function step(now) {
    if (!isSweeping || !stabilityMode) {
      stopSweep();
      return;
    }
    var dt = now - lastTime;
    lastTime = now;
    // Sweep speed: ~2.0 Å/sec for larger ranges, ~1.0 Å/sec for small
    var speed = sweepMax - SWEEP_MIN > 10 ? 2.0 : 1.0;
    sweepValue += (dt / 1000) * speed;

    if (sweepValue >= sweepMax) {
      sweepValue = sweepMax;
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
  // Re-enable Analyze
  var analyzeBtn = document.getElementById("analyze-interactions");
  if (analyzeBtn && sidePanelSelection.size >= 2 && sidePanelSelection.size <= 10) {
    analyzeBtn.disabled = false;
  }
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
