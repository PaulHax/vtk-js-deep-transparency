import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { variants } from './shader-variants.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseURL = process.env.DEMO_URL || 'http://127.0.0.1:10001';
const specsRoot =
  process.env.COMPARISON_SPECS ||
  path.join(root, 'Utilities/TestResults/pbr-isolation/specs');
const output =
  process.env.COMPARISON_OUTPUT ||
  path.join(root, 'Utilities/TestResults/pbr-isolation/browser');
const index = JSON.parse(
  await readFile(path.join(specsRoot, 'index.json'), 'utf8')
);
const cases = process.env.COMPARISON_CASES?.split(',');
const selectedVariants =
  process.env.PBR_VARIANTS?.split(',') || Object.keys(variants);
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
const browserExecutableSHA256 = createHash('sha256')
  .update(await readFile(chromium.executablePath()))
  .digest('hex');
try {
  for (const entry of index.cases.filter(
    (item) => !cases || cases.includes(item.name)
  )) {
    for (const variant of selectedVariants) {
      const target = path.join(output, variant);
      await mkdir(target, { recursive: true });
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
      const html = `/@fs/${path.join(root, 'Utilities/PBRComparison/browser.html')}`;
      const specURL = entry.url || `/@fs/${specPath}`;
      await page.goto(
        `${baseURL}${html}?spec=${encodeURIComponent(specURL)}&variant=${encodeURIComponent(variant)}`
      );
      await page.waitForFunction(() => !!globalThis.comparison?.ready);
      await page.evaluate(() => globalThis.comparison.ready);
      const pixels = await page.evaluate(() =>
        globalThis.comparison.readPixels()
      );
      const rgba = Buffer.from(pixels.rgba, 'base64');
      await writeFile(path.join(target, `${entry.name}.rgba`), rgba);
      const metadata = await page.evaluate(() => ({
        ...globalThis.comparison.metadata,
        gpuErrors: globalThis.comparison.errors,
      }));
      metadata.specificationSHA256 = createHash('sha256')
        .update(specBytes)
        .digest('hex');
      assert.equal(metadata.deepFramebufferEnabled, false);
      if (spec.mode === 'pbr') assert.ok(metadata.shaders.length > 0);
      for (let i = 0; i < metadata.shaders.length; i++) {
        const shader = metadata.shaders[i];
        const bytes = Buffer.from(shader.code);
        const filename = `${entry.name}-${i}.wgsl`;
        await writeFile(path.join(target, filename), bytes);
        shader.sha256 = createHash('sha256').update(bytes).digest('hex');
        shader.file = filename;
        delete shader.code;
      }
      metadata.browserVersion = browser.version();
      metadata.nodeVersion = process.version;
      metadata.browserExecutable = chromium.executablePath();
      metadata.browserExecutableSHA256 = browserExecutableSHA256;
      metadata.captureRGBASHA256 = createHash('sha256')
        .update(rgba)
        .digest('hex');
      metadata.errors = errors;
      await writeFile(
        path.join(target, `${entry.name}.json`),
        `${JSON.stringify(metadata, null, 2)}\n`
      );
      assert.deepEqual(errors, [], `${entry.name}: browser errors`);
      assert.deepEqual(metadata.gpuErrors, [], `${entry.name}: GPU errors`);
      console.log(
        `${entry.name}: captured ${pixels.width}x${pixels.height}, ${variant}`
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
