const displayInterval = 30000; // 30 seconds in milliseconds
let currentIndex = 0;
let isPaused = false;
let intervalHandle;
let currentPdbIds = [];

async function fetchPdbIds() {
  const response = await fetch("https://cors-anywhere.herokuapp.com/https://data.rcsb.org/rest/v1/holdings/current/entry_ids?list_type=entry_ids");
  if (response.ok) {
    const data = await response.json();
    return data;
  } else {
    throw new Error("Failed to fetch PDB IDs");
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
  currentIndex = (currentIndex + 1) % currentPdbIds.length;
  if (currentIndex === 0) {
    initSlideshow();
  } else {
    loadProteinStructure(currentPdbIds[currentIndex]);
  }
}

function moveBackward() {
  stage.setSpin(null); // stop spinning
  currentIndex = (currentIndex - 1 + currentPdbIds.length) % currentPdbIds.length;
  loadProteinStructure(currentPdbIds[currentIndex]);
}

initSlideshow();
//intervalHandle = setInterval(moveForward, displayInterval);

function loadProteinStructure(pdbId) {
  document.getElementById("model-name").textContent = `Model: ${pdbId}`;
  stage.removeAllComponents();
  stage.loadFile(`https://files.rcsb.org/download/${pdbId}.cif`, { defaultRepresentation: true })
    .then((structureComponent) => {
      stage.setSpin([0, 1, 0]); // start spinning
      structureComponent.autoView();
      logShownEntity(pdbId);
    });
}
