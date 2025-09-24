LinkedIn / Social sharing copy for Protein Side-chain Interaction Explorer

Short post
-----------
Try this interactive Protein Side‑chain Interaction Explorer — explore residue proximity and predicted side‑chain contacts from PDB structures in your browser. See it live: https://cfiorelli.github.io/proteinslideshow/

Expanded post
-------------
I built an interactive Protein Side‑chain Interaction Explorer that visualizes residue proximity and predicted chemical contacts from Protein Data Bank structures — no install required, works in your browser. Use the proximity slider and side‑chain selector to highlight nearby residues and inspect predicted interactions visually.

This is intended as a small research/teaching tool for structural biologists, educators, and anyone curious about protein contacts. It pulls public PDB data and renders it client‑side using NGL — you can try it with any valid PDB ID (example: 1TUP). The project and source code are available on GitHub for reproducibility and contributions.

Posting tips
-------------
- Attach a landscape image ~1200×630 px (prefer PNG/JPEG). If you have a short GIF showing the viewer in action, that can increase engagement.
- Alt text for images: "Screenshot of Protein Side‑chain Interaction Explorer showing NGL 3D view with a selected residue highlighted and side‑panel listing interacting residues."
- Suggested hashtags: #StructuralBiology #ProteinStructure #DataViz #Bioinformatics #OpenScience
- Suggested first comment: link to the GitHub repo and a quick usage tip (e.g., "Try PDB ID 1TUP and set proximity to 3Å").

OG image
--------
The site includes Open Graph meta tags in `index.html` that point at `/share-assets/og-image.png`. If you add a custom OG image, place it in `share-assets/og-image.png` and GitHub Pages / LinkedIn will pick it up when the page is shared.

Notes
-----
- The app fetches only public PDB files and does not collect user credentials or personal data. Run a quick smoke test before posting (open the URL in incognito, try 2–3 PDB IDs, and check the browser console for errors).
- If you prefer not to keep social copy in the repo, feel free to remove this file — it's optional.
