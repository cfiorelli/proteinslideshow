# Protein Slideshow

A lightweight browser viewer that cycles through random structures from the RCSB Protein Data Bank. Structures are rendered with [NGL](https://github.com/nglviewer/ngl) and enriched with live metadata so you can explore experimental details without leaving the page.

## Features

- **Random slideshow** of 15 PDB IDs at a time, refreshed automatically.
- **Robust structure loading**: tries gzipped CIF, raw CIF, then PDB files to avoid format/CORS quirks.
- **Metadata side panel** with experiment method, resolution, chains, symmetry, annotations, and primary literature links.
- **Representation controls** (Cartoon, Surface, Ball & Stick) for quick visual changes.
- **Side-chain interaction analysis** to detect hydrogen bonds, salt bridges, disulfides, and ionic contacts between selected residues.
- **Live highlighting & filtering** that zooms to labeled residues and suggests nearby partners based on precomputed contact maps.
- **Keyboard shortcuts**: `Space` toggles play/pause, `←` / `→` step backward/forward.
- **Responsive layout** that keeps the stage centered and metadata readable on phones and desktops.

## Getting Started

```bash
npm install
npm start
```

The dev proxy in `dev-proxy.js` serves `index.html` at `http://localhost:8000/` and forwards API requests so the browser can reach RCSB endpoints.

### Building for GitHub Pages

No build step is required. Commit the static files (`index.html`, `proteinslideshow.js`, `dev-proxy.js`, etc.) and enable GitHub Pages on the `main` branch. The site will be available at:

```
https://<your-username>.github.io/proteinslideshow/
```

## Controls & UI

| Action | How |
| --- | --- |
| Play / pause | Click the Play/Pause button or press `Space` |
| Next / previous structure | Click `Forward` / `Back` or press `→` / `←` |
| Change representation | Use the **Style** pill buttons (Cartoon / Surface / Ball & Stick) |
| Toggle spin | Click the **Spin** button (Stop/Start) in the toolbar |
| Analyze interactions | Pick residues in **Side-chain Interactions** and click **Analyze** |
| Filter residue list | Click **Filter Neighbors** to toggle between contacts-only and full residue lists |

Hover the metadata panel to see a rendered assembly preview, chain IDs, and primary citation details. Links to DOIs open in a new tab.

## Project Structure

- `index.html` – Page layout, styling, and UI controls.
- `proteinslideshow.js` – Slideshow logic, NGL integration, metadata fetching, and UI event handlers.
- `dev-proxy.js` – Simple Express proxy for local development.
- `package.json` – Scripts and dependencies.

## Notes

- RCSB occasionally rotates or removes structures. If a structure fails every format, the UI logs the error and continues with the next ID.
- The metadata panel fetches both entry-wide and polymer-entity data, plus assembly symmetry when available. If any API call fails, the panel shows a friendly fallback message.

## License

This project is provided as-is for personal and educational use. Consult the RCSB PDB [terms of use](https://www.rcsb.org/pages/policies) if you plan to deploy publicly.
