Share assets generator

Requirements

- Node.js >= 18
- npm

Install

```bash
cd share-assets
npm install
```

Generate GIF (captures the live demo and creates `proteinslideshow-demo.gif`):

```bash
npm run make:gif
```

Generate Open Graph PNG (creates `og-image.png`):

```bash
npm run make:og
```

Notes

- `make:gif` uses Puppeteer to load the live site; it will perform a small interaction sequence and capture frames. The clip area is tuned for typical desktop layout and may need adjustment.
- `make:og` creates a simple Open Graph image (1200×630 PNG) you can use when sharing the link.
