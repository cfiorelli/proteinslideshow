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
const playPauseButton = document.getElementById("play-pause");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");

fetchPdbIds()
  .then((entryIds) => {
    console.log(`There are currently ${entryIds.length} PDB IDs.`);
  })

  .catch((error) => {
    console.error("Error fetching PDB IDs:", error);
  });

playPauseButton.addEventListener("click", () => {
  console.log("Play/Pause button clicked."); // Debugging line
  isPaused = !isPaused;
  console.log(`isPaused is now ${isPaused}`); // Debugging line
  playPauseButton.textContent = isPaused ? "Play" : "Pause";
  if (isPaused) {
    console.log("Pausing the slideshow."); // Debugging line
    clearInterval(intervalHandle);
  } else {
    console.log("Playing the slideshow."); // Debugging line
    intervalHandle = setInterval(moveForward, displayInterval);
  }
});


backButton.addEventListener("click", moveBackward);
forwardButton.addEventListener("click", moveForward);


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

async function loadProteinStructure(pdbId) {
  const modelNameEl = document.getElementById("model-name");
  modelNameEl.textContent = `Model: ${pdbId}`;
  stage.removeAllComponents();

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
      stage.setSpin([0, 1, 0]); // start spinning
      structureComponent.autoView();
      logShownEntity(pdbId);
      modelNameEl.textContent = `Model: ${pdbId}`;
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Failed to load ${pdbId} from ${source.url}:`, err);
    }
  }

  console.error(`Failed to load structure ${pdbId} from all sources.`, lastError);
  modelNameEl.textContent = `Model: ${pdbId} (failed to load)`;
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
    defaultRepresentation: true,
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
