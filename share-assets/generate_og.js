const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');

const OUT = path.resolve(__dirname, 'og-image.png');
const WIDTH = 1200;
const HEIGHT = 630;

(async () => {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#0b1221';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // accent panel
  ctx.fillStyle = '#131c33';
  ctx.fillRect(60, 60, WIDTH - 120, HEIGHT - 120);

  // title
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 56px Sans';
  ctx.fillText('Protein Side-chain', 100, 180);
  ctx.fillText('Interaction Explorer', 100, 250);

  // subtitle
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '20px Sans';
  const subtitle = 'Explore residue proximity and predicted chemical contacts in the browser.';
  wrapText(ctx, subtitle, 100, 300, WIDTH - 240, 26);

  // small badge / url
  ctx.fillStyle = '#94a3b8';
  ctx.font = '18px Sans';
  ctx.fillText('cfiorelli.github.io/proteinslideshow', 100, HEIGHT - 80);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(OUT, buffer);
  console.log('OG image written to', OUT);

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    let line = '';
    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        ctx.fillText(line, x, y);
        line = words[n] + ' ';
        y += lineHeight;
      } else {
        line = testLine;
      }
    }
    if (line) ctx.fillText(line, x, y);
  }
})();
