import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseURL = process.env.DEMO_URL || 'http://127.0.0.1:9999';
const specsRoot =
  process.env.COMPARISON_SPECS ||
  path.join(root, 'Data/deep-transparency/comparison/specs');
const output =
  process.env.COMPARISON_OUTPUT ||
  path.join(
    root,
    'Utilities/TestResults/deep-transparency/native-webgpu/browser'
  );
const index = JSON.parse(
  await readFile(path.join(specsRoot, 'index.json'), 'utf8')
);
const cases = process.env.COMPARISON_CASES?.split(',');
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
  for (const entry of index.cases.filter(
    (item) => !cases || cases.includes(item.name)
  )) {
    const specPath = entry.path || path.join(specsRoot, `${entry.name}.json`);
    const specBytes = await readFile(specPath);
    const spec = JSON.parse(specBytes);
    for (const actor of spec.actors) {
      if (actor.sha256)
        assert.equal(
          createHash('sha256')
            .update(await readFile(actor.path))
            .digest('hex'),
          actor.sha256
        );
    }
    const page = await browser.newPage({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const html = `/@fs/${path.join(root, 'Utilities/DeepFramebufferComparison/browser.html')}`;
    const specURL =
      entry.url ||
      `/Data/deep-transparency/comparison/specs/${entry.name}.json`;
    await page.goto(`${baseURL}${html}?spec=${encodeURIComponent(specURL)}`);
    await page.waitForFunction(() => !!globalThis.comparison?.ready);
    await page.evaluate(() => globalThis.comparison.ready);
    const pixels = await page.evaluate(() =>
      globalThis.comparison.readPixels()
    );
    const rgba = Buffer.from(pixels.rgba, 'base64');
    await writeFile(path.join(output, `${entry.name}.rgba`), rgba);
    await page.evaluate(() => globalThis.comparison.reverse());
    const reversed = await page.evaluate(() =>
      globalThis.comparison.readPixels()
    );
    const reverseRGBA = Buffer.from(reversed.rgba, 'base64');
    let orderDifferingChannels = 0;
    for (let i = 0; i < rgba.length; i++)
      if (rgba[i] !== reverseRGBA[i]) orderDifferingChannels++;
    const metadata = await page.evaluate(() => ({
      ...globalThis.comparison.metadata,
      gpuErrors: globalThis.comparison.errors,
    }));
    metadata.specificationSHA256 = createHash('sha256')
      .update(specBytes)
      .digest('hex');
    metadata.orderDifferingChannels = orderDifferingChannels;
    metadata.errors = errors;
    await writeFile(
      path.join(output, `${entry.name}.json`),
      `${JSON.stringify(metadata, null, 2)}\n`
    );
    await page.screenshot({
      path: path.join(output, `${entry.name}-canvas.png`),
    });
    assert.deepEqual(errors, [], `${entry.name}: browser errors`);
    assert.deepEqual(metadata.gpuErrors, [], `${entry.name}: GPU errors`);
    console.log(
      `${entry.name}: captured ${pixels.width}x${pixels.height}, ${orderDifferingChannels} channels change with draw order`
    );
    await page.close();
  }
} finally {
  await browser.close();
}
