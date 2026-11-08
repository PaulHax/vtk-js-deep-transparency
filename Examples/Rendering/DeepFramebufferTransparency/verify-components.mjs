import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = process.env.DEMO_URL || 'http://127.0.0.1:9999';
const output = path.resolve(
  process.env.DEMO_OUTPUT_DIR || path.join(root, 'comparison/components')
);
const cases = [
  {
    scene: 'anatomy',
    filename: 'anatomy',
    labels: [
      'Facial bone (CT contour)',
      'Right maxillary sinus',
      'Left maxillary sinus',
      'Right nasal cavity',
      'Left nasal cavity',
      'Nasopharynx',
    ],
  },
  {
    scene: 'cad',
    filename: 'bearing',
    labels: ['Outer race', 'Inner race', 'Rolling balls', 'Retainer cage'],
  },
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  await page.goto(`${url}/?scene=layers`);
  await page.waitForFunction(() => globalThis.demo);
  await page.evaluate(() => globalThis.demo.ready);
  const results = [];
  const legend = page.locator('#legend');
  const canvas = page.locator('#viewport canvas');

  const capture = () =>
    page.evaluateHandle(() => globalThis.demo.view.getPixelsAsync());
  const compare = (reference) =>
    page.evaluate(async (before) => {
      const after = await globalThis.demo.view.getPixelsAsync();
      if (before.width !== after.width || before.height !== after.height)
        throw new Error('Canvas dimensions changed during component toggling');
      const differingPixels = [0, 0];
      const differingChannels = [0, 0];
      for (let y = 0; y < before.height; y++) {
        for (let x = 0; x < before.width; x++) {
          const viewport = x < before.width / 2 ? 0 : 1;
          const offset = (y * before.width + x) * 4;
          let changed = false;
          for (let channel = 0; channel < 4; channel++) {
            if (
              before.colorValues[offset + channel] !==
              after.colorValues[offset + channel]
            ) {
              differingChannels[viewport]++;
              changed = true;
            }
          }
          if (changed) differingPixels[viewport]++;
        }
      }
      return {
        width: before.width,
        height: before.height,
        weighted: {
          differingPixels: differingPixels[0],
          differingChannels: differingChannels[0],
        },
        deep: {
          differingPixels: differingPixels[1],
          differingChannels: differingChannels[1],
        },
      };
    }, reference);

  for (const specification of cases) {
    await page.evaluate(async (scene) => {
      await globalThis.demo.setScene(scene);
      globalThis.demo.view.getDevice().getHandle().pushErrorScope('validation');
    }, specification.scene);
    assert.deepEqual(
      await legend.locator('label').allTextContents(),
      specification.labels,
      `${specification.scene}: anatomy and component labels`
    );
    for (const label of specification.labels) {
      assert.equal(
        await legend
          .getByRole('checkbox', { name: label, exact: true })
          .isChecked(),
        true,
        `${specification.scene}: ${label} starts visible`
      );
    }
    const baseline = await capture();
    const originalScreenshot = await canvas.screenshot();
    await page.screenshot({
      path: path.join(output, `${specification.filename}.png`),
      fullPage: true,
    });
    const outer = legend.getByRole('checkbox', {
      name: specification.labels[0],
      exact: true,
    });
    await outer.uncheck();
    await page.evaluate(() => globalThis.demo.render());
    assert.equal(await outer.isChecked(), false);
    const hidden = await compare(baseline);
    assert.ok(
      hidden.weighted.differingPixels > 0,
      'Weighted viewport must expose interior components'
    );
    assert.ok(
      hidden.deep.differingPixels > 0,
      'Deep viewport must expose interior components'
    );
    const exposedScreenshot = await canvas.screenshot();
    assert.notEqual(sha256(exposedScreenshot), sha256(originalScreenshot));
    await page.screenshot({
      path: path.join(output, `${specification.filename}-exposed.png`),
      fullPage: true,
    });
    await outer.check();
    await page.evaluate(() => globalThis.demo.render());
    assert.equal(await outer.isChecked(), true);
    const restored = await compare(baseline);
    assert.equal(
      restored.weighted.differingChannels,
      0,
      'Weighted pixels must restore exactly'
    );
    assert.equal(
      restored.deep.differingChannels,
      0,
      'Deep pixels must restore exactly'
    );
    const restoredScreenshot = await canvas.screenshot();
    assert.deepEqual(
      restoredScreenshot,
      originalScreenshot,
      'Canvas screenshot must restore exactly'
    );
    const validationError = await page.evaluate(async () => {
      const error = await globalThis.demo.view
        .getDevice()
        .getHandle()
        .popErrorScope();
      return error?.message || null;
    });
    assert.equal(validationError, null, 'GPU validation');
    await baseline.dispose();
    results.push({
      scene: specification.scene,
      labels: specification.labels,
      hiddenComponent: specification.labels[0],
      hidden,
      restored,
      screenshotSHA256: {
        original: sha256(originalScreenshot),
        exposed: sha256(exposedScreenshot),
        restored: sha256(restoredScreenshot),
      },
      validationError,
    });
    console.log(
      `Verified ${specification.scene} component visibility and exact image restoration`
    );
  }
  assert.deepEqual(errors, [], 'Browser errors');
  await writeFile(
    path.join(output, 'report.json'),
    `${JSON.stringify({ url, results, errors }, null, 2)}\n`
  );
  console.log(`Component screenshots and report: ${output}`);
} finally {
  await browser.close();
}
