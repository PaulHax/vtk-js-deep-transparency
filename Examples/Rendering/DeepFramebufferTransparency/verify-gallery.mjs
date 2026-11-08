import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = process.env.DEMO_URL || 'http://127.0.0.1:9999';
const output = path.resolve(
  process.env.DEMO_OUTPUT_DIR || path.join(root, 'comparison/gallery')
);
const scenes = [
  'nested',
  'intersecting',
  'layers',
  'bonsai',
  'engine',
  'teapot',
  'impact',
  'anatomy',
  'cad',
];
const generated = new Set(['nested', 'intersecting', 'layers', 'cad']);
await mkdir(output, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--enable-features=Vulkan',
    '--use-vulkan=swiftshader',
  ],
});
const errors = [];
const attachErrors = (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
};

const readyFrame = async (page, key) => {
  await page.waitForFunction((scene) => {
    const iframe = document.querySelector(`section#${scene} iframe`);
    return iframe?.getAttribute('src')?.includes(`scene=${scene}`);
  }, key);
  const handle = await page.locator(`section#${key} iframe`).elementHandle();
  const frame = await handle.contentFrame();
  assert.ok(frame, `${key}: example frame exists`);
  await frame.waitForURL(
    (location) => location.searchParams.get('scene') === key
  );
  await frame.waitForFunction(() => globalThis.demo);
  await frame.evaluate(() => globalThis.demo.ready);
  await frame.evaluate(() => globalThis.demo.controls.whenIdle());
  return frame;
};

const paint = (page, count) =>
  page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);

const submissions = (frames) =>
  Promise.all(
    frames.map((frame) =>
      frame.evaluate(() => globalThis.galleryQueueSubmissions)
    )
  );

const inspect = async (frame, key) => {
  assert.equal(
    await frame.locator('.scene-tabs').count(),
    0,
    `${key}: no separate procedural button group`
  );
  for (const selector of ['#opacity', '#reverse', '#reset', '#legend']) {
    assert.equal(
      await frame.locator(selector).isVisible(),
      true,
      `${key}: common ${selector} control is visible`
    );
  }
  assert.equal(await frame.locator('#dataset-credit').isVisible(), true);
  const credit = await frame.locator('#credit').innerText();
  assert.ok(credit.trim(), `${key}: visible model creator caption`);
  const note = await frame.locator('#attribution-note').textContent();
  const source = await frame.locator('#source').getAttribute('href');
  const license = await frame.locator('#license').getAttribute('href');
  if (generated.has(key)) {
    assert.match(credit, /created for this demo/i);
    assert.equal(await frame.locator('#source').isVisible(), false);
    assert.equal(await frame.locator('#license').isVisible(), false);
  } else {
    assert.equal(await frame.locator('#source').isVisible(), true);
    assert.ok(/^https?:\/\//.test(source), `${key}: source link`);
    assert.ok(note.trim(), `${key}: visible modifications caption`);
  }
  if (['bonsai', 'engine', 'teapot'].includes(key)) {
    assert.match(credit, /Pavol Klacansky/);
    assert.match(credit, /volvis\.org/);
  }
  if (key === 'anatomy') {
    assert.match(credit, /NasalSeg/);
    assert.match(credit, /P001/);
    assert.match(credit, /Yichi Zhang/);
    assert.match(note, /smoothed/);
    assert.match(note, /bone/i);
    assert.equal(await frame.locator('#license').isVisible(), true);
    assert.match(await frame.locator('#license').innerText(), /CC BY 4\.0/);
    assert.equal(license, 'https://creativecommons.org/licenses/by/4.0/');
    assert.match(source, /10\.5281\/zenodo\.13893419/);
  }
  if (key === 'impact') {
    assert.equal(await frame.locator('#mirror-credit').isVisible(), true);
    assert.match(await frame.locator('#mirror-credit').innerText(), /Pont/);
  }
  const image = await frame.evaluate(async () => {
    const { demo } = globalThis;
    const device = demo.view.getDevice().getHandle();
    device.pushErrorScope('validation');
    await demo.render();
    const pixels = await demo.view.getPixelsAsync();
    const foregroundPixels = [0, 0];
    const backgrounds = demo.renderers.map((renderer) =>
      renderer
        .getBackground()
        .slice(0, 3)
        .map((channel) => Math.round(channel * 255))
    );
    for (let y = 0; y < pixels.height; y++) {
      for (let x = 0; x < pixels.width; x++) {
        const pane = x < pixels.width / 2 ? 0 : 1;
        const offset = (y * pixels.width + x) * 4;
        if (
          backgrounds[pane].some(
            (channel, i) =>
              Math.abs(channel - pixels.colorValues[offset + i]) > 2
          )
        )
          foregroundPixels[pane]++;
      }
    }
    const error = await device.popErrorScope();
    return {
      width: pixels.width,
      height: pixels.height,
      foregroundPixels,
      validationError: error?.message || null,
    };
  });
  assert.equal(image.validationError, null, `${key}: GPU validation`);
  for (const count of image.foregroundPixels)
    assert.ok(count > 0, `${key}: each viewport displays geometry`);
  return { key, credit, note, source, license, image };
};

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  await context.addInitScript(() => {
    globalThis.galleryQueueSubmissions = 0;
    if (!globalThis.GPUQueue) return;
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function submitCommands(...args) {
      globalThis.galleryQueueSubmissions++;
      return Reflect.apply(submit, this, args);
    };
  });
  const page = await context.newPage();
  attachErrors(page);
  await page.goto(url);
  await page.locator('section#nested iframe').waitFor({ state: 'attached' });
  for (const key of scenes) {
    assert.equal(await page.locator(`section#${key}`).count(), 1);
    assert.equal(await page.locator(`nav a[href="#${key}"]`).count(), 1);
  }
  const initialFrames = await Promise.all(
    scenes.map((key) => readyFrame(page, key))
  );
  assert.equal(
    await page.locator('iframe[src*="embed=1"]').count(),
    9,
    'All nine examples start when the gallery opens'
  );
  await paint(page, 2);
  await Promise.all(
    initialFrames.map((frame) =>
      frame.evaluate(() =>
        globalThis.demo.view.getDevice().getHandle().queue.onSubmittedWorkDone()
      )
    )
  );
  const beforeIdle = await submissions(initialFrames);
  assert.ok(
    beforeIdle.every((count) => count > 0),
    'Every example submitted its initial image'
  );
  await paint(page, 8);
  const afterIdle = await submissions(initialFrames);
  assert.deepEqual(
    afterIdle,
    beforeIdle,
    'Idle examples do not submit rendering work'
  );
  await page.screenshot({ path: path.join(output, 'gallery-navigation.png') });

  const results = [];
  for (const key of scenes) {
    await page.locator(`nav a[href="#${key}"]`).click();
    await page.waitForFunction((scene) => location.hash === `#${scene}`, key);
    const frame = await readyFrame(page, key);
    const result = await inspect(frame, key);
    result.activeFrames = await page.locator('iframe[src*="embed=1"]').count();
    assert.equal(
      result.activeFrames,
      9,
      `${key}: all examples remain available`
    );
    if (['nested', 'bonsai', 'anatomy', 'cad'].includes(key)) {
      await page.locator(`section#${key}`).screenshot({
        path: path.join(output, `${key}.png`),
      });
    }
    results.push(result);
    console.log(
      `Verified #${key}, its common controls, model caption and image`
    );
  }

  await page.goto(`${url}/#anatomy`);
  const anchored = await readyFrame(page, 'anatomy');
  await inspect(anchored, 'anatomy');
  const anchorVisible = await page
    .locator('section#anatomy')
    .evaluate((section) => {
      const rect = section.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
  assert.equal(
    anchorVisible,
    true,
    'Direct anatomy anchor scrolls to its example'
  );

  const canvas = anchored.locator('#viewport canvas');
  const bounds = await canvas.boundingBox();
  assert.ok(bounds, 'Embedded arcball canvas is visible');
  const center = {
    x: bounds.x + bounds.width * 0.75,
    y: bounds.y + bounds.height / 2,
  };
  const radius = Math.min(bounds.width / 2, bounds.height) / 2;
  const camera = () =>
    anchored.evaluate(() => {
      const active = globalThis.demo.camera;
      return {
        position: [...active.getPosition()],
        focal: [...active.getFocalPoint()],
        up: [...active.getViewUp()],
        scale: active.getParallelScale(),
      };
    });
  const initialCamera = await camera();
  const initialImage = await canvas.screenshot();
  await page.mouse.move(center.x + radius * 0.9, center.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(center.x, center.y - radius * 0.9, { steps: 8 });
  await page.mouse.up({ button: 'left' });
  await anchored.evaluate(() => globalThis.demo.controls.whenIdle());
  const rotatedCamera = await camera();
  assert.notDeepEqual(
    rotatedCamera.position,
    initialCamera.position,
    'Left drag rotates the embedded example'
  );
  assert.deepEqual(
    rotatedCamera.focal,
    initialCamera.focal,
    'Arcball keeps its orbit center'
  );
  assert.notDeepEqual(
    rotatedCamera.up,
    initialCamera.up,
    'Arcball retains free roll'
  );
  assert.notDeepEqual(
    await canvas.screenshot(),
    initialImage,
    'Arcball changes the displayed image'
  );
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(center.x + 32, center.y + 20, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await anchored.evaluate(() => globalThis.demo.controls.whenIdle());
  const pannedCamera = await camera();
  assert.notDeepEqual(
    pannedCamera.focal,
    rotatedCamera.focal,
    'Right drag pans the embedded example'
  );
  assert.deepEqual(
    pannedCamera.up,
    rotatedCamera.up,
    'Panning keeps the camera orientation'
  );
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -80);
  await anchored.evaluate(() => globalThis.demo.controls.whenIdle());
  const zoomedCamera = await camera();
  assert.ok(
    zoomedCamera.scale < pannedCamera.scale,
    'Wheel zooms the embedded example'
  );
  await page
    .locator('section#anatomy')
    .screenshot({ path: path.join(output, 'anatomy-arcball.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await anchored.evaluate(() => globalThis.demo.render());
  await anchored.evaluate(() => globalThis.demo.resetCamera());
  const mobile = await page.evaluate(() => ({
    width: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    mobile.contentWidth <= mobile.width,
    'Mobile gallery has no horizontal overflow'
  );
  const embeddedMobile = await anchored.evaluate(() => ({
    width: window.innerWidth,
    contentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(
    embeddedMobile.contentWidth <= embeddedMobile.width,
    'Mobile controls and caption have no horizontal overflow'
  );
  await page.locator('section#anatomy').screenshot({
    path: path.join(output, 'anatomy-mobile.png'),
  });
  assert.deepEqual(
    errors,
    [],
    'Browser errors across embedded example lifecycles'
  );
  await writeFile(
    path.join(output, 'report.json'),
    `${JSON.stringify({ url, results, idleSubmissions: { before: beforeIdle, after: afterIdle }, directAnchor: 'anatomy', gestures: { leftArcball: true, rightPan: true, wheelZoom: true }, mobile, embeddedMobile, errors }, null, 2)}\n`
  );
  console.log(`Gallery verification passed. Screenshots and report: ${output}`);
} finally {
  await browser.close();
}
