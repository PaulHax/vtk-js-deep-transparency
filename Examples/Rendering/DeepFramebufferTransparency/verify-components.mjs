import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseURL = new URL(process.env.DEMO_URL || 'http://127.0.0.1:9999');
if (!baseURL.pathname.endsWith('/')) baseURL.pathname += '/';
baseURL.search = '';
baseURL.hash = '';
const url = baseURL.href;
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
  const viewerURL = new URL(url);
  viewerURL.searchParams.set('scene', 'layers');
  await page.goto(viewerURL.href);
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
    assert.equal(
      await page.locator('#opacity').count(),
      0,
      'No shared opacity slider'
    );
    assert.deepEqual(
      await legend.locator('.component-name').allTextContents(),
      specification.labels,
      `${specification.scene}: component labels`
    );
    assert.equal(
      await legend.locator('.component-row').count(),
      specification.labels.length
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(
          root,
          'Data/deep-transparency',
          specification.scene,
          'manifest.json'
        ),
        'utf8'
      )
    );
    const initialOpacities = manifest.scenes[specification.scene].actors.map(
      (actor) => actor.opacity
    );
    const values = () =>
      legend
        .locator('input[type="range"]')
        .evaluateAll((inputs) => inputs.map((input) => input.valueAsNumber));
    assert.deepEqual(
      await values(),
      initialOpacities,
      `${specification.scene}: original component opacities`
    );
    for (const [index, label] of specification.labels.entries()) {
      const eye = legend.getByRole('button', {
        name: `Hide ${label}`,
        exact: true,
      });
      assert.equal(
        await eye.getAttribute('aria-pressed'),
        'true',
        `${label}: starts visible`
      );
      const slider = legend.getByRole('slider', {
        name: `${label} opacity`,
        exact: true,
      });
      assert.equal(await slider.getAttribute('min'), '0');
      assert.equal(await slider.getAttribute('max'), '1');
      assert.equal(await slider.inputValue(), String(initialOpacities[index]));
    }
    const baseline = await capture();
    const originalScreenshot = await canvas.screenshot();
    await page.screenshot({
      path: path.join(output, `${specification.filename}.png`),
      fullPage: true,
    });
    const outer = legend.locator('#component-0');
    await outer.click();
    await page.evaluate(() => globalThis.demo.render());
    assert.equal(await outer.getAttribute('aria-pressed'), 'false');
    assert.equal(
      await outer.getAttribute('aria-label'),
      `Show ${specification.labels[0]}`
    );
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
    const hiddenBaseline = await capture();
    const hiddenSlider = legend.locator('#component-opacity-0');
    for (const key of ['Home', 'End']) {
      await hiddenSlider.press(key);
      await page.evaluate(() => globalThis.demo.render());
      assert.equal(
        await outer.getAttribute('aria-pressed'),
        'false',
        'Opacity changes keep the component hidden'
      );
      const stillHidden = await compare(hiddenBaseline);
      assert.equal(
        stillHidden.weighted.differingChannels,
        0,
        'Hidden opacity does not change weighted pixels'
      );
      assert.equal(
        stillHidden.deep.differingChannels,
        0,
        'Hidden opacity does not change deep pixels'
      );
      assert.deepEqual(
        (await values()).slice(1),
        initialOpacities.slice(1),
        'Hidden opacity leaves other components unchanged'
      );
    }
    await page.evaluate(
      (opacity) => globalThis.demo.setComponentOpacity(0, opacity),
      initialOpacities[0]
    );
    await hiddenBaseline.dispose();
    await outer.click();
    await page.evaluate(() => globalThis.demo.render());
    assert.equal(await outer.getAttribute('aria-pressed'), 'true');
    assert.equal(
      await outer.getAttribute('aria-label'),
      `Hide ${specification.labels[0]}`
    );
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
    const opacityChecks = [];
    for (const [index, label] of specification.labels.entries()) {
      const slider = legend.getByRole('slider', {
        name: `${label} opacity`,
        exact: true,
      });
      await slider.press('Home');
      await page.evaluate(() => globalThis.demo.render());
      const zeroValues = [...initialOpacities];
      zeroValues[index] = 0;
      assert.deepEqual(
        await values(),
        zeroValues,
        `${label}: zero opacity changes only this component`
      );
      assert.equal(
        await legend.locator(`#component-opacity-value-${index}`).textContent(),
        '0%'
      );
      const zero = await compare(baseline);
      assert.ok(
        zero.weighted.differingPixels > 0,
        `${label}: zero opacity changes weighted pixels`
      );
      assert.ok(
        zero.deep.differingPixels > 0,
        `${label}: zero opacity changes deep pixels`
      );
      const zeroImage = await capture();
      await slider.press('End');
      await page.evaluate(() => globalThis.demo.render());
      const oneValues = [...initialOpacities];
      oneValues[index] = 1;
      assert.deepEqual(
        await values(),
        oneValues,
        `${label}: full opacity changes only this component`
      );
      assert.equal(
        await legend.locator(`#component-opacity-value-${index}`).textContent(),
        '100%'
      );
      const one = await compare(zeroImage);
      assert.ok(
        one.weighted.differingPixels > 0,
        `${label}: full opacity changes weighted pixels`
      );
      assert.ok(
        one.deep.differingPixels > 0,
        `${label}: full opacity changes deep pixels`
      );
      await zeroImage.dispose();
      if (index === 0)
        await page.screenshot({
          path: path.join(output, `${specification.filename}-opaque.png`),
          fullPage: true,
        });
      await page.evaluate(
        ({ component, opacity }) =>
          globalThis.demo.setComponentOpacity(component, opacity),
        { component: index, opacity: initialOpacities[index] }
      );
      assert.deepEqual(
        await values(),
        initialOpacities,
        `${label}: original controls restore`
      );
      const original = await compare(baseline);
      assert.equal(
        original.weighted.differingChannels,
        0,
        `${label}: weighted pixels restore exactly`
      );
      assert.equal(
        original.deep.differingChannels,
        0,
        `${label}: deep pixels restore exactly`
      );
      opacityChecks.push({ label, zero, one, exactRestoration: true });
    }
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
      opacityChecks,
      hiddenOpacityPreservesVisibility: true,
      validationError,
    });
    console.log(
      `Verified ${specification.scene} component visibility, independent opacity and exact image restoration`
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
