(function (global) {
  'use strict';
  const MAX_SELECTION = 10;
  const DISABLED_REASON = "Disabled: no side-chain interactions exist with your current selection.";

  const state = {
    container: null,
    listEl: null,
    analyzeButton: null,
    clearButton: null,
    searchInput: null,
    liveRegion: null,
    residues: [],
    listItems: new Map(),
    selectedResidues: new Set(),
    disabledResidues: new Set(),
    contactMapCache: new Map(),
    inProximitySet: new Set(),
    interactionSet: new Set(),
    proximityThreshold: 5,
    dividerEl: null,
    filterQuery: "",
  };

  function ensureLiveRegion() {
    if (state.liveRegion) return;
    const region = document.createElement("div");
    region.id = "live-region";
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    state.container.prepend(region);
    state.liveRegion = region;
  }

  function announce(message) {
    ensureLiveRegion();
    if (!state.liveRegion) return;
    state.liveRegion.textContent = "";
    state.liveRegion.textContent = message;
  }

  function dispatchEvent(name, detail) {
    if (!state.container) return;
    const event = new CustomEvent(name, { bubbles: true, detail });
    state.container.dispatchEvent(event);
  }

  function updateAnalyzeButton() {
    if (!state.analyzeButton) return;
    const count = state.selectedResidues.size;
    state.analyzeButton.disabled = count < 2 || count > MAX_SELECTION;
  }

  function setFilterQuery(raw = "") {
    const normalized = raw.trim();
    if (state.searchInput && state.searchInput.value !== normalized) {
      state.searchInput.value = normalized;
    }
    state.filterQuery = normalized.toLowerCase();
    applySearchFilter();
  }

  function applySearchFilter() {
    const query = state.filterQuery;
    const hasQuery = query.length > 0;
    state.listItems.forEach(({ element, label }) => {
      const labelText = label || element.dataset.label || "";
      const match = !hasQuery || labelText.includes(query);
      element.style.display = match ? "" : "none";
    });
    if (state.dividerEl) {
      state.dividerEl.style.display = hasQuery ? "none" : "";
    }
  }

  function handleSearchInput(event) {
    setFilterQuery(event.target.value || "");
  }

  function handleSearchKeydown(event) {
    if (event.key !== "Enter") return;
    const matches = [];
    state.listItems.forEach(({ element }, key) => {
      if (element.style.display === "none") return;
      matches.push(key);
    });
    if (!matches.length) return;
    const firstMatch = matches[0];
    const residue = state.residues.find((item) => (item.key || item.id) === firstMatch);
    const label = residue ? residue.label : firstMatch;
    const next = new Set(state.selectedResidues);
    next.add(firstMatch);
    commitSelection(next, {
      focusKey: firstMatch,
      focus: true,
      reason: "search",
      message: `${label} selected from search results.`,
    });
  }

  function syncSelectionUI() {
    state.listItems.forEach(({ element, checkbox, tip }, key) => {
      const isSelected = state.selectedResidues.has(key);
      const isDisabled = state.disabledResidues.has(key) && !isSelected;
      const hasInteraction = state.interactionSet.has(key);
      const isInProximity = state.inProximitySet.has(key) && !hasInteraction && !isSelected;

      checkbox.checked = isSelected;
      checkbox.disabled = isDisabled;
      checkbox.tabIndex = isDisabled ? -1 : 0;

      element.classList.toggle("is-selected", isSelected);
      element.classList.toggle("muted", isDisabled);
      element.classList.toggle("has-interaction", hasInteraction);
      element.classList.toggle("in-proximity", isInProximity);
      element.setAttribute("aria-selected", String(isSelected));
      element.setAttribute("aria-disabled", String(isDisabled));

      if (tip) {
        tip.hidden = !isDisabled;
      }
    });

    updateAnalyzeButton();
  }

  function getOrderedKeys() {
    if (!state.residues.length) return [];
    const selectedKeys = [];
    const interactionKeys = [];
    const proximityKeys = [];
    const otherKeys = [];
    state.residues.forEach((residue) => {
      const key = residue.key || residue.id;
      if (state.selectedResidues.has(key)) {
        selectedKeys.push(key);
      } else if (state.interactionSet.has(key)) {
        interactionKeys.push(key);
      } else if (state.inProximitySet.has(key)) {
        proximityKeys.push(key);
      } else {
        otherKeys.push(key);
      }
    });
    return selectedKeys.concat(interactionKeys, proximityKeys, otherKeys);
  }

  function reorderResidueList() {
    if (!state.listEl) return;
    if (!state.listItems.size) {
      state.listEl.innerHTML = "";
      return;
    }

    const orderedKeys = getOrderedKeys();
    if (!orderedKeys.length) {
      state.listEl.innerHTML = "";
      return;
    }

    const fragment = document.createDocumentFragment();
    let dividerInserted = false;
    const shouldShowDivider = (state.inProximitySet.size > 0 || state.selectedResidues.size > 0 || state.interactionSet.size > 0)
      && orderedKeys.some((key) =>
        !state.selectedResidues.has(key)
        && !state.inProximitySet.has(key)
        && !state.interactionSet.has(key),
      );

    orderedKeys.forEach((key) => {
      const entry = state.listItems.get(key);
      if (!entry) return;

      const isSelected = state.selectedResidues.has(key);
      const isInProximity = state.inProximitySet.has(key);
      const hasInteraction = state.interactionSet.has(key);

      if (
        shouldShowDivider &&
        !dividerInserted &&
        !isSelected &&
        !isInProximity &&
        !hasInteraction
      ) {
        if (!state.dividerEl) {
          state.dividerEl = document.createElement("li");
          state.dividerEl.className = "analysis-divider";
        }
        state.dividerEl.textContent = `---- Proximity limit ${state.proximityThreshold.toFixed(1).replace(/\\.0$/, "")}Å ----`;
        fragment.appendChild(state.dividerEl);
        dividerInserted = true;
      }

      fragment.appendChild(entry.element);
    });

    if (!dividerInserted && state.dividerEl && state.dividerEl.parentElement) {
      state.dividerEl.parentElement.removeChild(state.dividerEl);
    }

    state.listEl.innerHTML = "";
    state.listEl.appendChild(fragment);
    applySearchFilter();
  }

  function commitSelection(nextSelected, { focusKey = null, focus = false, reason = "update", message, accepted = true } = {}) {
    state.selectedResidues = new Set(nextSelected || []);
    reorderResidueList();
    if (typeof message === "string" && message.length) {
      announce(message);
    } else {
      announce(`Selected ${state.selectedResidues.size} residue(s).`);
    }
    dispatchEvent("sidepanel:residueSelected", {
      residueKey: focusKey,
      selected: focus,
      accepted,
      reason,
      selectedResidues: Array.from(state.selectedResidues),
    });
  }

  function handleListChange(event) {
    const checkbox = event.target;
    if (!checkbox || checkbox.type !== "checkbox") return;
    const key = checkbox.getAttribute("data-residue-key");
    if (!key || !state.listItems.has(key)) return;

    if (state.disabledResidues.has(key) && !state.selectedResidues.has(key)) {
      checkbox.checked = false;
      announce("No interactions available. Selection unchanged.");
      dispatchEvent("sidepanel:residueSelected", {
        residueKey: key,
        selected: false,
        accepted: false,
        reason: "disabled",
        selectedResidues: Array.from(state.selectedResidues),
      });
      return;
    }

    const nextSelected = new Set(state.selectedResidues);
    const isSelecting = checkbox.checked;

    if (isSelecting) {
      if (state.selectedResidues.size >= MAX_SELECTION) {
        checkbox.checked = false;
        announce(`Maximum of ${MAX_SELECTION} residues reached.`);
        dispatchEvent("sidepanel:residueSelected", {
          residueKey: key,
          selected: false,
          accepted: false,
          reason: "limit",
          selectedResidues: Array.from(state.selectedResidues),
        });
        return;
      }
      nextSelected.add(key);
    } else {
      nextSelected.delete(key);
    }

    const residue = state.residues.find((item) => item.key === key || item.id === key);
    const label = residue ? residue.label : key;
    commitSelection(nextSelected, {
      focusKey: key,
      focus: isSelecting,
      reason: isSelecting ? "select" : "deselect",
      message: `${label} ${isSelecting ? "selected" : "deselected"}.`,
    });
  }

  function handleAnalyzeClick() {
    if (!state.analyzeButton || state.analyzeButton.disabled) return;
    dispatchEvent("sidepanel:analyze", {
      selectedResidues: Array.from(state.selectedResidues),
    });
  }

  function handleClearSelections() {
    if (!state.selectedResidues.size) {
      announce("No residues currently selected.");
      return;
    }
    commitSelection(new Set(), {
      focusKey: null,
      focus: false,
      reason: "clear",
      message: "All selections cleared.",
    });
  }

  function normalizeQuery(value = "") {
    return value.replace(/\s+/g, "").toLowerCase();
  }

  function findResidueByQuery(query) {
    if (!query) return null;
    const normalizedQuery = normalizeQuery(query);
    let match = state.residues.find((residue) => normalizeQuery(residue.label || residue.key || residue.id) === normalizedQuery);
    if (match) return match;
    match = state.residues.find((residue) => normalizeQuery(residue.key || residue.id) === normalizedQuery);
    if (match) return match;
    const compact = query.replace(/\s+/g, "").toUpperCase();

    const resChainMatch = compact.match(/^([A-Z]{3})([A-Z]?)(\d+)$/);
    if (resChainMatch) {
      const [, resname, chain, resno] = resChainMatch;
      match = state.residues.find((residue) => {
        const sameName = (residue.resname || "").toUpperCase() === resname;
        const sameNo = String(residue.resno || "").toUpperCase() === resno;
        if (!sameName || !sameNo) return false;
        if (!chain) return true;
        return (residue.chain || "").toUpperCase() === chain;
      });
      if (match) return match;
    }

    const chainResMatch = compact.match(/^([A-Z]?)(\d+)$/);
    if (chainResMatch) {
      const [, chain, resno] = chainResMatch;
      match = state.residues.find((residue) => {
        const sameNo = String(residue.resno || "").toUpperCase() === resno;
        if (!sameNo) return false;
        if (!chain) return true;
        return (residue.chain || "").toUpperCase() === chain;
      });
      if (match) return match;
    }

    const resOnlyMatch = compact.match(/^([A-Z]{3})(\d+)$/);
    if (resOnlyMatch) {
      const [, resname, resno] = resOnlyMatch;
      match = state.residues.find((residue) => {
        const sameName = (residue.resname || "").toUpperCase() === resname;
        return sameName && String(residue.resno || "").toUpperCase() === resno;
      });
      if (match) return match;
    }

    const lowerQuery = query.toLowerCase();
    return state.residues.find((residue) => {
      const label = (residue.label || "").toLowerCase();
      if (label.includes(lowerQuery)) return true;
      const combined = `${residue.resname || ""} ${residue.chain || ""}${residue.resno || ""}`.toLowerCase();
      return combined.includes(lowerQuery);
    });
  }

  function attachListeners() {
    if (state.listEl) {
      state.listEl.addEventListener("change", handleListChange);
    }
    if (state.analyzeButton) {
      state.analyzeButton.addEventListener("click", handleAnalyzeClick);
    }
    if (state.clearButton) {
      state.clearButton.addEventListener("click", handleClearSelections);
    }
    if (state.searchInput) {
      state.searchInput.addEventListener("input", handleSearchInput);
      state.searchInput.addEventListener("keydown", handleSearchKeydown);
    }
  }

  function renderResidueList(residues = []) {
    if (!state.listEl) return;
    state.residues = Array.from(residues);
    state.contactMapCache = new Map();
    state.listItems.clear();
    state.disabledResidues.clear();
    state.inProximitySet = new Set();
    state.interactionSet = new Set();
    state.dividerEl = null;
    state.listEl.innerHTML = "";

    if (!state.residues.length) {
      state.filterQuery = "";
      if (state.searchInput) {
        state.searchInput.value = "";
      }
      applySearchFilter();
      syncSelectionUI();
      return;
    }

    const fragment = document.createDocumentFragment();

    state.residues.forEach((residue) => {
      const key = residue.key || residue.id;
      const item = document.createElement("li");
      item.className = "analysis-item item";
      item.setAttribute("role", "option");
      item.setAttribute("data-residue-key", key);

      const label = document.createElement("label");
      label.className = "analysis-item-label";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("data-residue-key", key);

      const labelText = residue.label || key;
      const text = document.createElement("span");
      text.textContent = labelText;

      const tip = document.createElement("span");
      tip.className = "tip";
      tip.textContent = DISABLED_REASON;
      tip.hidden = true;

      item.dataset.label = labelText.toLowerCase();
      label.appendChild(checkbox);
      label.appendChild(text);
      item.appendChild(label);
      item.appendChild(tip);
      fragment.appendChild(item);

      state.listItems.set(key, { element: item, checkbox, tip, label: labelText.toLowerCase() });
    });

    state.listEl.appendChild(fragment);
    reorderResidueList();
    syncSelectionUI();
  }

  function updateSelections(selectedResidues = []) {
    state.selectedResidues = new Set(selectedResidues);
    reorderResidueList();
    syncSelectionUI();
  }

  function applyFilter(validResidues, { proximity = new Set(), interaction = new Set(), threshold } = {}) {
    const allowSet = !validResidues ? null : new Set(validResidues);

    state.disabledResidues = new Set();
    state.inProximitySet = new Set(proximity || []);
    state.interactionSet = new Set(interaction || []);

    if (typeof threshold === "number" && !Number.isNaN(threshold)) {
      state.proximityThreshold = threshold;
    }

    if (allowSet) {
      state.residues.forEach((residue) => {
        const key = residue.key || residue.id;
        if (!allowSet.has(key) && !state.selectedResidues.has(key)) {
          state.disabledResidues.add(key);
        }
      });
    }

    reorderResidueList();
    syncSelectionUI();
  }

  function init(containerEl) {
    state.container = containerEl || document.getElementById("analysis-panel");
    if (!state.container) {
      throw new Error("SidePanel container element not found.");
    }
    state.listEl = state.container.querySelector("#residue-list");
    state.analyzeButton = state.container.querySelector("#analyze-interactions");
    state.clearButton = state.container.querySelector("#clear-selections");
    state.searchInput = state.container.querySelector("#residue-search-input");
    state.liveRegion = state.container.querySelector("#live-region");
    if (state.searchInput && state.filterQuery) {
      state.searchInput.value = state.filterQuery;
    }

    ensureLiveRegion();
    attachListeners();
    syncSelectionUI();

    return api;
  }

  const api = {
    init,
    renderResidueList,
    updateSelections,
    applyFilter,
    announce,
  };

  global.SidePanel = api;
})(window);
