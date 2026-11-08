import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const url = process.env.DEMO_URL || 'http://127.0.0.1:9999';
const outputDirectory = path.resolve(
  process.env.DEMO_OUTPUT_DIR || '/tmp/deep-transparency-demo'
);
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
  ],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const viewerUrl = new URL(url);
  viewerUrl.searchParams.set('scene', 'layers');
  await page.goto(viewerUrl.href);
  await page.waitForFunction(() => globalThis.demo);
  await page.evaluate(() => globalThis.demo.ready);

  const orderChecks = [];
  for (const scene of ['nested', 'intersecting', 'layers']) {
    const result = await page.evaluate(async (key) => {
      const { demo } = globalThis;
      await demo.setScene(key);
      const before = await demo.view.getPixelsAsync();
      await demo.reverseOrder();
      const after = await demo.view.getPixelsAsync();
      let differingChannels = 0;
      for (let y = 0; y < before.height; y++) {
        for (let x = before.width / 2; x < before.width; x++) {
          for (let channel = 0; channel < 4; channel++) {
            const index = (y * before.width + x) * 4 + channel;
            if (before.colorValues[index] !== after.colorValues[index]) {
              differingChannels++;
            }
          }
        }
      }
      await demo.reverseOrder();
      return { scene: key, differingChannels };
    }, scene);
    assert.equal(
      result.differingChannels,
      0,
      `${scene}: reversing draw order changed the deep framebuffer image`
    );
    orderChecks.push(result);
    await page.screenshot({
      path: path.join(outputDirectory, `${scene}.png`),
      fullPage: true,
    });
  }

  const sampleOverlap = () =>
    page.evaluate(async () => {
      const image = await globalThis.demo.view.getPixelsAsync();
      const offset =
        (Math.floor(image.height / 2) * image.width +
          Math.floor((image.width * 3) / 4)) *
        4;
      return Array.from(image.colorValues.slice(offset, offset + 4));
    });

  const redFront = await sampleOverlap();
  assert.deepEqual(redFront, [128, 0, 64, 255]);
  const captureCanvas = (name) =>
    page.locator('#viewport canvas').screenshot({
      path: path.join(outputDirectory, name),
    });
  const displayedRedFront = await captureCanvas('canvas-red-front-1x.png');
  await page.evaluate(() => globalThis.demo.swapDepths());
  const blueFront = await sampleOverlap();
  assert.deepEqual(blueFront, [64, 0, 128, 255]);
  const displayedBlueFront = await captureCanvas('canvas-blue-front-1x.png');
  assert.equal(displayedRedFront.equals(displayedBlueFront), false);
  await page.screenshot({
    path: path.join(outputDirectory, 'layers-blue-front.png'),
    fullPage: true,
  });

  await page.locator('#opacity').press('Home');
  await page.locator('#opacity').press('ArrowRight');
  await page.evaluate(() => globalThis.demo.render());
  assert.equal(await page.locator('#opacity-value').textContent(), '6%');
  await page.evaluate(() => globalThis.demo.setOpacity(0.5));

  await page.evaluate(async () => {
    const { demo } = globalThis;
    await demo.swapDepths();
    demo.view.setMultiSample(4);
    await demo.setOpacity(0.25);
  });
  const displayedFourSamples = await captureCanvas('canvas-red-front-4x.png');
  assert.equal(
    displayedFourSamples.equals(displayedRedFront),
    false,
    'Displayed canvas kept stale content after changing sample count and opacity'
  );
  await page.evaluate(async () => {
    const { demo } = globalThis;
    demo.view.setMultiSample(1);
    await demo.swapDepths();
    await demo.setOpacity(0.5);
  });
  const displayedReturnedBlue = await captureCanvas(
    'canvas-blue-front-return-1x.png'
  );
  assert.equal(
    displayedReturnedBlue.equals(displayedBlueFront),
    true,
    'Displayed canvas differs from its original blue-front image after 4-to-1 sample change'
  );
  await page.evaluate(() => globalThis.demo.swapDepths());
  const displayedReturnedRed = await captureCanvas(
    'canvas-red-front-return-1x.png'
  );
  assert.equal(
    displayedReturnedRed.equals(displayedRedFront),
    true,
    'Displayed canvas differs from its original red-front image after restoring the scene'
  );

  await page.setViewportSize({ width: 800, height: 1000 });
  await page.waitForFunction(() => {
    const viewport = document.querySelector('#viewport');
    const width = viewport.getBoundingClientRect().width;
    return globalThis.demo.view.getSize()[0] === Math.round(width / 2) * 2;
  });
  await page.evaluate(() => globalThis.demo.render());
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    true,
    'Responsive layout overflows horizontally'
  );
  await page.screenshot({
    path: path.join(outputDirectory, 'responsive.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, [], 'Browser or WebGPU errors occurred');

  const report = {
    url,
    orderChecks,
    redFront,
    blueFront,
    displayedCanvasSampleChanges: {
      fourSamplesChangedImage: true,
      restoredBlueFrontExact: true,
      restoredRedFrontExact: true,
    },
    browserErrors: errors,
    screenshots: [
      'nested.png',
      'intersecting.png',
      'layers.png',
      'layers-blue-front.png',
      'canvas-red-front-1x.png',
      'canvas-blue-front-1x.png',
      'canvas-red-front-4x.png',
      'canvas-blue-front-return-1x.png',
      'canvas-red-front-return-1x.png',
      'responsive.png',
    ],
  };
  await writeFile(
    path.join(outputDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(`Demo verification passed. Screenshots: ${outputDirectory}`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
