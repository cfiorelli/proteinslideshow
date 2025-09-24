const puppeteer = require('puppeteer');
const GIFEncoder = require('gifencoder');
const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

// Config
const URL = 'https://cfiorelli.github.io/proteinslideshow/';
const OUTPUT = path.resolve(__dirname, 'proteinslideshow-demo.gif');
const WIDTH = 900;
const HEIGHT = 500;
const DURATION_MS = 3000; // total duration
const FPS = 10;

(async () => {
  const frames = Math.max(1, Math.round((DURATION_MS / 1000) * FPS));
  const encoder = new GIFEncoder(WIDTH, HEIGHT);
  const out = fs.createWriteStream(OUTPUT);
  encoder.createReadStream().pipe(out);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(Math.round(1000 / FPS));
  encoder.setQuality(10);

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // perform a simple interaction sequence while capturing frames
  // 1) wait, 2) set proximity to 3Å, 3) select first residue, 4) select interacting residue, 5) click Analyze
  await page.waitForTimeout(800);

  // set proximity slider to 3Å
  await page.evaluate(() => {
    const slider = document.getElementById('proximity-threshold');
    if (slider) slider.value = 3;
    const ev = new Event('input', { bubbles: true });
    if (slider) slider.dispatchEvent(ev);
  });
  await page.waitForTimeout(600);

  // try to select the first visible residue item
  await page.evaluate(() => {
    const list = document.getElementById('residue-list');
    if (!list) return;
    const item = list.querySelector('.analysis-item');
    if (!item) return;
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.disabled) checkbox.click();
  });
  await page.waitForTimeout(600);

  // capture frames over a short period while spinning the stage a bit
  for (let i = 0; i < frames; i++) {
    // rotate stage slightly
    await page.evaluate((i) => {
      try {
        if (window.stage && typeof window.stage.setSpin === 'function') {
          if (i % 2 === 0) window.stage.setSpin([0, 1, 0]);
          else window.stage.setSpin(null);
        }
      } catch (e) {}
    }, i);
    const screenshot = await page.screenshot({ type: 'png', clip: { x: 80, y: 100, width: WIDTH, height: HEIGHT } });
    // feed frame to encoder
    const png = PNG.sync.read(screenshot);
    encoder.addFrame(png.data);
  }

  encoder.finish();
  await browser.close();
  console.log('GIF written to', OUTPUT);
})();
