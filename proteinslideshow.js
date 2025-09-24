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

// Add this new function to initialize the slideshow with the fetched PDB IDs
async function initSlideshow() {
  currentPdbIds = await getPdbIds(); // Store the fetched PDB IDs in the currentPdbIds variable
  // if the list is empty, try a safe fallback so the UI still shows something
  if (!currentPdbIds || currentPdbIds.length === 0) {
    const fallback = ["1CRN", "4HHB", "1A4W", "2HYY", "6VXX", "1UBQ", "2OOB", "3LZT", "4HHB", "5XNL", "1BNA", "2XHE", "3J3Q", "1HHO", "1TUP"];
    console.warn("Using fallback PDB IDs because none were fetched.", fallback);
    currentPdbIds = fallback;
  }
  if (currentPdbIds.length > 0) {
    currentIndex = 0;
    loadProteinStructure(currentPdbIds[currentIndex]);
    //intervalHandle = setInterval(moveForward, displayInterval);
  } else {
    console.error("Failed to initialize the slideshow");
  }
}

function logShownEntity(pdbId) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}] Shown entity: ${pdbId}`);
}




const stage = new NGL.Stage("viewport");
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
const residueListEl = document.getElementById("residue-list");
const analyzeButton = document.getElementById("analyze-interactions");
const interactionResultsEl = document.getElementById("interaction-results");
const toggleSpinButton = document.getElementById("toggle-spin");
const toggleFilterButton = document.getElementById("toggle-filter");

if (interactionResultsEl && !interactionResultsEl.dataset.state) {
  interactionResultsEl.dataset.state = "info-default";
}

let metadataRequestToken = 0;
let currentComponent = null;
let currentRepresentationMode = "cartoon";
let currentStructure = null;
let interactionShapeComponent = null;
let lastHighlightSelection = null;
let selectedResidueIndices = new Set();
let isSpinning = false;
let representationHandles = {};
let residueDataMap = new Map();
let residueContactMap = new Map();
let residueListElements = new Map();
let residueColorMap = new Map();
let selectedResidueVisuals = new Map();
let filterNeighbors = true;
let focusTimeout = null;

const HIGHLIGHT_COLORS = [
  "#f97316",
  "#22d3ee",
  "#c084fc",
  "#facc15",
  "#4ade80",
  "#fb7185",
  "#38bdf8",
  "#f472b6",
];

const CONTACT_DISTANCE_CUTOFF = 5.0; // Å

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
      type: "cartoon",
      params: {
        sele: "polymer",
        colorScheme: "chainname",
      },
    },
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


fetchPdbIds()
  .then((entryIds) => {
    console.log(`There are currently ${entryIds.length} PDB IDs.`);
  })

  .catch((error) => {
    console.error("Error fetching PDB IDs:", error);
  });

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

if (analyzeButton) {
  analyzeButton.addEventListener("click", handleAnalyzeInteractions);
}

if (toggleSpinButton) {
  toggleSpinButton.addEventListener("click", toggleSpin);
}
updateSpinControlUI();
updateSpinState();

if (toggleFilterButton) {
  toggleFilterButton.addEventListener("click", () => {
    filterNeighbors = !filterNeighbors;
    updateFilterButton();
    updateResidueFilter();
    updateSelectionUIState();
  });
}
updateFilterButton();

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


function moveForward() {
  stage.setSpin(null); // stop spinning
  if (!currentPdbIds || currentPdbIds.length === 0) {
    console.warn("No PDB IDs available when moving forward.");
    return;
  }
  currentIndex = (currentIndex + 1) % currentPdbIds.length;
  // when we wrap to zero, re-seed the list (optional) to get fresh entries
  if (currentIndex === 0) {
    initSlideshow();
  } else {
    loadProteinStructure(currentPdbIds[currentIndex]);
  }
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
  playPauseButton.textContent = isPaused ? "Play ▶" : "Pause ❚❚";
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

  if (options.rebuild || !representationHandles[currentRepresentationMode]) {
    rebuildRepresentationHandles();
  }

  if (!representationHandles[currentRepresentationMode] || representationHandles[currentRepresentationMode].length === 0) {
    if (currentRepresentationMode !== "cartoon") {
      console.warn(`Falling back to cartoon representation after ${currentRepresentationMode} failure.`);
      currentRepresentationMode = "cartoon";
      updateRepresentationToggleState();
    }
    if (!representationHandles[currentRepresentationMode]) {
      rebuildRepresentationHandles();
    }
  }

  setRepresentationVisibility(currentRepresentationMode);
  updateSelectionHighlight({ force: true });
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

function rebuildRepresentationHandles() {
  if (!currentComponent) return;
  currentComponent.removeAllRepresentations();
  representationHandles = {};

  Object.entries(representationConfigs).forEach(([mode, configs]) => {
    const reps = [];
    configs.forEach((config) => {
      try {
        const params = Object.assign({}, config.params || {});
        if (mode !== currentRepresentationMode) {
          params.visible = false;
        }
        const rep = currentComponent.addRepresentation(config.type, params);
        reps.push(rep);
      } catch (err) {
        console.warn(`Failed to build ${mode} representation (${config.type})`, err);
      }
    });
    representationHandles[mode] = reps;
  });

  if (!representationHandles.cartoon || representationHandles.cartoon.length === 0) {
    representationHandles.cartoon = [
      currentComponent.addRepresentation("cartoon", {
        sele: "polymer",
        colorScheme: "chainname",
        aspectRatio: 3,
        visible: currentRepresentationMode === "cartoon",
      }),
    ];
  }

  setRepresentationVisibility(currentRepresentationMode);
  updateSelectionHighlight({ force: true });
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
  toggleSpinButton.textContent = isSpinning ? "Stop Spin" : "Start Spin";
  toggleSpinButton.classList.toggle("is-active", !isSpinning);
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

function updateResidueCheckboxStyles() {
  residueListElements.forEach(({ wrapper, checkbox }) => {
    wrapper.classList.toggle("is-selected", checkbox.checked);
  });
}

function buildResidueCache(structure) {
  residueDataMap = new Map();
  residueContactMap = new Map();

  structure.eachResidue((residue) => {
    if (!residue.isProtein()) return;
    const data = buildResidueData(structure, residue.index);
    residueDataMap.set(residue.index, data);
  });

  computeResidueContacts(structure);
}

function computeResidueContacts(structure) {
  residueContactMap = new Map();
  const dataArray = Array.from(residueDataMap.values());

  dataArray.forEach((residue) => {
    residueContactMap.set(residue.residueIndex, new Set());
  });

  const atomProxyA = structure.getAtomProxy();
  const atomProxyB = structure.getAtomProxy();

  for (let i = 0; i < dataArray.length; i += 1) {
    for (let j = i + 1; j < dataArray.length; j += 1) {
      const resA = dataArray[i];
      const resB = dataArray[j];

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
        residueContactMap.get(resA.residueIndex).add(resB.residueIndex);
        residueContactMap.get(resB.residueIndex).add(resA.residueIndex);
      }
    }
  }
}

function updateResidueFilter() {
  if (!residueListEl) return;
  const showAll = !filterNeighbors || selectedResidueIndices.size === 0;
  const allowed = new Set();
  let visibleCount = 0;

  if (showAll) {
    residueListElements.forEach((_, index) => {
      allowed.add(index);
    });
  } else {
    selectedResidueIndices.forEach((index) => {
      allowed.add(index);
      const neighbors = residueContactMap.get(index);
      if (neighbors) {
        neighbors.forEach((neighbor) => allowed.add(neighbor));
      }
    });
  }

  residueListElements.forEach(({ wrapper, checkbox }, index) => {
    const isSelected = selectedResidueIndices.has(index);
    const visible = showAll ? true : allowed.has(index) || isSelected;

    wrapper.style.display = visible ? "flex" : "none";
    wrapper.classList.toggle("is-filtered", !visible);
    checkbox.disabled = !visible && !isSelected;
    if (visible) visibleCount += 1;
  });

  updateResidueCheckboxStyles();

  if (
    filterNeighbors &&
    selectedResidueIndices.size > 0 &&
    interactionResultsEl &&
    interactionResultsEl.dataset.state !== "results"
  ) {
    const selectedCount = selectedResidueIndices.size;
    if (visibleCount <= selectedCount) {
      setInteractionMessage("No nearby residues found with current filter.", "info-warning");
    }
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

function updateFilterButton() {
  if (!toggleFilterButton) return;
  toggleFilterButton.textContent = filterNeighbors ? "Filter Neighbors" : "Show All Residues";
  toggleFilterButton.classList.toggle("is-active", filterNeighbors);
}

function clearAnalysisUI(message = "Choose residues above to analyze side-chain interactions.") {
  selectedResidueIndices.clear();
  residueColorMap.clear();
  residueListElements.clear();
  clearResidueVisuals();
  lastHighlightSelection = null;
  clearInteractionVisuals();
  residueDataMap = new Map();
  residueContactMap = new Map();

  if (residueListEl) {
    residueListEl.innerHTML = "";
  }
  if (analyzeButton) {
    analyzeButton.disabled = true;
  }
  setInteractionMessage(message, "info-default");
}

function setInteractionMessage(message, state = "info-default") {
  if (!interactionResultsEl) return;
  interactionResultsEl.textContent = message;
  interactionResultsEl.dataset.state = state;
}

function populateResidueList(structure) {
  if (!residueListEl) return;
  residueListEl.innerHTML = "";
  residueListElements.clear();
  residueColorMap.clear();
  clearResidueVisuals();
  selectedResidueIndices.clear();
  lastHighlightSelection = null;
  clearInteractionVisuals();

  if (!structure) {
    if (analyzeButton) analyzeButton.disabled = true;
    setInteractionMessage("Load a structure before analysis.", "info-default");
    return;
  }

  buildResidueCache(structure);

  const residues = Array.from(residueDataMap.values()).sort((a, b) => {
    if (a.chain === b.chain) return a.resno - b.resno;
    return a.chain.localeCompare(b.chain);
  });

  if (!residues.length) {
    if (analyzeButton) analyzeButton.disabled = true;
    setInteractionMessage("No protein residues available for analysis in this structure.", "info-default");
    return;
  }

  residues.forEach((residue) => {
    const labelEl = document.createElement("label");
    labelEl.className = "analysis-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.residueIndex = String(residue.residueIndex);
    checkbox.addEventListener("change", handleResidueToggleChange);

    const textSpan = document.createElement("span");
    textSpan.textContent = residue.label;

    labelEl.appendChild(checkbox);
    labelEl.appendChild(textSpan);
    residueListEl.appendChild(labelEl);

    residueListElements.set(residue.residueIndex, {
      wrapper: labelEl,
      checkbox,
      text: textSpan,
    });
  });

  updateResidueFilter();
  updateSelectionUIState();
}

function handleResidueToggleChange(event) {
  const checkbox = event.target;
  if (!checkbox || !checkbox.dataset.residueIndex) return;
  const residueIndex = parseInt(checkbox.dataset.residueIndex, 10);
  if (Number.isNaN(residueIndex)) return;

  if (checkbox.checked) {
    if (selectedResidueIndices.size >= 10) {
      checkbox.checked = false;
      setInteractionMessage("Maximum of 10 residues reached. Deselect one before adding another.", "info-warning");
      return;
    }
    selectedResidueIndices.add(residueIndex);
  } else {
    selectedResidueIndices.delete(residueIndex);
  }

  const elements = residueListElements.get(residueIndex);
  if (elements) {
    elements.wrapper.classList.toggle("is-selected", checkbox.checked);
  }

  const focusOn = checkbox.checked;
  updateSelectionHighlight({ focusOn });

  if (
    interactionResultsEl &&
    interactionResultsEl.dataset.state === "results" &&
    selectedResidueIndices.size >= 2 &&
    selectedResidueIndices.size <= 10
  ) {
    setInteractionMessage("Selection changed. Click Analyze to refresh interactions.", "info-dirty");
  }

  updateResidueFilter();
  updateSelectionUIState();
}

function updateSelectionUIState() {
  const count = selectedResidueIndices.size;
  if (analyzeButton) {
    analyzeButton.disabled = count < 2 || count > 10;
  }
  if (!interactionResultsEl) return;

  const preserveWarning =
    interactionResultsEl.dataset.state === "info-warning" &&
    filterNeighbors &&
    count >= 1 &&
    count <= 10 &&
    interactionResultsEl.textContent.startsWith("No nearby residues");

  if (preserveWarning && count >= 1) {
    return;
  }

  if (count === 0) {
    setInteractionMessage("Select 2–10 residues to compare.", "info-default");
  } else if (count === 1) {
    setInteractionMessage("Select at least one more residue.", "info-default");
  } else if (count > 10) {
    setInteractionMessage("Please deselect residues until you have 10 or fewer selected.", "info-warning");
  } else if (
    interactionResultsEl.dataset.state !== "results" &&
    interactionResultsEl.dataset.state !== "info-dirty"
  ) {
    setInteractionMessage("Click Analyze to inspect interactions between the selected residues.", "info-ready");
  }
}

function updateSelectionHighlight({ focusOn = false, force = false } = {}) {
  if (!currentStructure) {
    clearResidueVisuals();
    lastHighlightSelection = null;
    return;
  }

  if (force) {
    clearResidueVisuals();
  }

  const selectionParts = [];
  Array.from(selectedResidueVisuals.keys()).forEach((index) => {
    if (!selectedResidueIndices.has(index)) {
      removeResidueVisual(index);
    }
  });

  selectedResidueIndices.forEach((index) => {
    const residueData = residueDataMap.get(index) || buildResidueData(currentStructure, index);
    if (!residueData) return;

    if (!residueColorMap.has(index)) {
      const color = HIGHLIGHT_COLORS[residueColorMap.size % HIGHLIGHT_COLORS.length];
      residueColorMap.set(index, color);
    }

    if (!selectedResidueVisuals.has(index)) {
      const color = residueColorMap.get(index);
      const visuals = createResidueVisuals(residueData, color);
      selectedResidueVisuals.set(index, visuals);
    }

    selectionParts.push(residueData.selectionString);
  });

  updateResidueCheckboxStyles();

  if (selectionParts.length === 0) {
    lastHighlightSelection = null;
    return;
  }

  lastHighlightSelection = selectionParts.join(" OR ");

  if (focusOn && lastHighlightSelection) {
    scheduleFocus(lastHighlightSelection);
  }
}

function handleAnalyzeInteractions() {
  if (!interactionResultsEl || !currentComponent) return;
  if (!currentStructure) {
    setInteractionMessage("Load a structure before running the analysis.", "info-default");
    return;
  }

  const residueIndices = Array.from(selectedResidueIndices);
  if (residueIndices.length < 2 || residueIndices.length > 10) {
    updateSelectionUIState();
    return;
  }

  const residueData = residueIndices.map((index) => residueDataMap.get(index) || buildResidueData(currentStructure, index));
  const interactions = [];
  const involvedAtoms = new Set();

  for (let i = 0; i < residueData.length; i += 1) {
    for (let j = i + 1; j < residueData.length; j += 1) {
      analyzeResiduePair(residueData[i], residueData[j], interactions, involvedAtoms);
    }
  }

  renderInteractionResults(residueData, interactions);
  updateInteractionVisuals(residueData, interactions, involvedAtoms);
}

async function loadProteinStructure(pdbId) {
  const modelNameEl = document.getElementById("model-name");
  modelNameEl.textContent = `Model: ${pdbId}`;
  stage.removeAllComponents();
  currentComponent = null;
  currentStructure = null;
  clearAnalysisUI("Loading structure; residue list will appear shortly.");

  updateMetadataPanel(pdbId);

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
    modelNameEl.textContent = `Model: ${pdbId} (loading ${source.label}...)`;
    try {
      const structureComponent = await fetchAndLoadStructure(pdbId, source);
      currentComponent = structureComponent;
      currentStructure = structureComponent.structure;
      representationHandles = {};
      applyCurrentRepresentation({ rebuild: true });
      structureComponent.autoView();
      updateSpinState();
      logShownEntity(pdbId);
      modelNameEl.textContent = `Model: ${pdbId}`;
      populateResidueList(currentStructure);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Failed to load ${pdbId} from ${source.url}:`, err);
    }
  }

  console.error(`Failed to load structure ${pdbId} from all sources.`, lastError);
  modelNameEl.textContent = `Model: ${pdbId} (failed to load)`;
  clearAnalysisUI("Unable to analyze until a structure loads successfully.");
  if (lastError && lastError.message && /CORS|cross-origin|NetworkError/i.test(lastError.message)) {
    console.warn("Possible CORS or network error when loading structure. Check console and server CORS headers.");
  }
}

async function fetchAndLoadStructure(pdbId, source) {
  const response = await fetch(source.url);
  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (/html|json|text\/html|application\/json/i.test(contentType)) {
    const body = await response.text().catch(() => "(unable to read body)");
    console.error(`Unexpected content-type ${contentType} when fetching ${source.url}. Body:\n`, body);
    throw new Error(`Unexpected content-type ${contentType}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const fileLike = makeFileLike(arrayBuffer, `${pdbId}.${source.fileExt}`, source.mime || "application/octet-stream");

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

function updateMetadataPanel(pdbId) {
  if (!metadataContentEl) return;
  const token = ++metadataRequestToken;
  setMetadataMessage(`Loading details for ${escapeHtml(pdbId)}…`, "metadata-loading");

  fetchEntryMetadata(pdbId)
    .then((metadata) => {
      if (token !== metadataRequestToken) return; // stale request
      renderMetadata(metadata);
    })
    .catch((err) => {
      if (token !== metadataRequestToken) return;
      console.error(`Error fetching metadata for ${pdbId}:`, err);
      setMetadataMessage("Unable to load metadata right now. Try again later.", "metadata-error");
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

  return {
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

function renderInteractionResults(residueData, interactions) {
  if (!interactionResultsEl) return;
  if (!interactions.length) {
    interactionResultsEl.textContent = "No side-chain interactions detected between the selected residues (within default distance thresholds).";
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

  updateSelectionHighlight();

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

async function fetchEntryMetadata(pdbId) {
  const entryUrl = `https://data.rcsb.org/rest/v1/core/entry/${pdbId}`;
  const entryData = await fetchJson(entryUrl, `entry metadata for ${pdbId}`);

  let polymerData;
  const polymerIds = entryData?.rcsb_entry_container_identifiers?.polymer_entity_ids || [];
  if (polymerIds.length > 0) {
    const polymerUrl = `https://data.rcsb.org/rest/v1/core/polymer_entity/${pdbId}/${polymerIds[0]}`;
    try {
      polymerData = await fetchJson(polymerUrl, `polymer metadata for ${pdbId}`);
    } catch (err) {
      console.warn(`Unable to fetch polymer metadata for ${pdbId}:`, err);
    }
  }

  let assemblyData;
  const assemblyIds = entryData?.rcsb_entry_container_identifiers?.assembly_ids || [];
  if (assemblyIds.length > 0) {
    const assemblyUrl = `https://data.rcsb.org/rest/v1/core/assembly/${pdbId}/${assemblyIds[0]}`;
    try {
      assemblyData = await fetchJson(assemblyUrl, `assembly metadata for ${pdbId}`);
    } catch (err) {
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

async function fetchJson(url, label) {
  const response = await fetch(url);
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
