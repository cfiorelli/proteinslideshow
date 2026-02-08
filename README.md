# Protein Side-chain Interaction Explorer

A browser-based tool for exploring residue proximity and side-chain interactions in PDB structures. Built with [NGL](https://github.com/nglviewer/ngl) and RCSB PDB data.

## Run locally

```bash
# Option A: Python static server (no install needed)
python3 -m http.server 8765
# Then open http://localhost:8765

# Option B: Node dev proxy (if you need CORS proxy for development)
npm install
npm start
# Opens at http://localhost:8080
```

No build step required. For GitHub Pages, commit the static files and enable Pages on the `main` branch.

## How it works

1. On load, the app fetches and renders **6LYZ** (lysozyme) as the default structure.
2. Select **2–10 residues** from the side panel, then click **Analyze** to detect side-chain contacts.
3. Use the **Stability** button to sweep distance cutoffs and assess interaction robustness.

## Interaction types

| Type | Cutoff | Atoms |
| --- | --- | --- |
| Hydrogen bond | ≤ 3.5 Å | Donor–acceptor pairs (see `HYDROGEN_DONOR_MAP` / `HYDROGEN_ACCEPTOR_MAP`) |
| Salt bridge | ≤ 4.0 Å | Charged side-chain atoms (ARG/LYS/HIS vs ASP/GLU) |
| Ionic interaction | ≤ 6.0 Å | Same atom pairs as salt bridge, wider cutoff |
| Disulfide bond | ≤ 2.2 Å | CYS SG – CYS SG |

**Limitations:** Water-mediated contacts and π-stacking interactions are not detected. Only side-chain atoms are considered (backbone excluded).

## Controls

| Action | How |
| --- | --- |
| Load a PDB | Enter a 4-character ID in the header search box and click **Load** |
| Navigate structures | **←** / **→** buttons or arrow keys; **⏸** / **▶** for slideshow |
| Change representation | **Cartoon** / **Surface** / **Ball+Stick** in the toolbar |
| Toggle spin | **Spin** button in toolbar |
| Search residues | Type in the residue search box (e.g., `ALA A42`, `CYS 64`) |
| Adjust proximity | Drag the threshold slider (1–5 Å) |
| Analyze interactions | Select 2–10 residues, click **Analyze** |
| Stability sweep | After Analyze, click **Stability** to see persistence ranges |
| Focus camera | Click **Focus** to re-center on selected residues |
| Debug logging | Append `?debug=1` to the URL for verbose console output |

## Troubleshooting

**Blank viewer / nothing loads:**
- Check the browser console for errors. The most common cause is a network issue fetching from `files.rcsb.org`.
- Try appending `?debug=1` to the URL — this enables detailed logging of every load step.
- If 6LYZ fails, the app automatically tries 1CRN as a fallback.

**Metadata panel empty:**
- Metadata is fetched from `data.rcsb.org`. If the API is down or blocked, the panel shows "Metadata unavailable."

**Selection visuals disappear when switching representation:**
- This was a known bug (fixed). If you see it, please file an issue.

## Project structure

- `index.html` – Layout, styling, and UI controls (single file).
- `proteinslideshow.js` – Core logic: NGL viewer, load pipeline, interaction detection, stability explorer.
- `sidepanel.js` – Side panel state management (residue list, filtering, selection events).
- `dev-proxy.js` – Express CORS proxy for local development.

## License

This project is provided as-is for personal and educational use. See RCSB PDB [terms of use](https://www.rcsb.org/pages/policies).
