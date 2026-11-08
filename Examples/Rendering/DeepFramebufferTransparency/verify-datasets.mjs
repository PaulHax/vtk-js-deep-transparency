import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = process.env.DEMO_URL || 'http://127.0.0.1:9999';
const output = path.resolve(
  process.env.DEMO_OUTPUT_DIR ||
    path.join(root, 'Utilities/TestResults/deep-transparency/datasets')
);
const names = (
  process.env.DATASET_SCENES || 'bonsai,engine,teapot,impact,anatomy,cad'
).split(',');
const groupFor = (name) =>
  ['impact', 'anatomy', 'cad'].includes(name) ? name : 'scans';
const manifests = {};
for (const group of new Set(
  names.map(groupFor)
)) {
  manifests[group] = JSON.parse(
    await readFile(
      path.join(root, 'Data/deep-transparency', group, 'manifest.json'),
      'utf8'
    )
  );
}
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
  for (const name of names) {
    const specification =
      manifests[groupFor(name)].scenes[name];
    assert.ok(specification, `No prepared data for ${name}`);
    for (const actor of specification.actors) {
      const bytes = await readFile(
        path.join(root, actor.url.replace(/^\//, ''))
      );
      if (actor.sha256)
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          actor.sha256,
          `${name}: mesh checksum`
        );
    }
    const result = await page.evaluate(async (key) => {
      const { demo } = globalThis;
      const device = demo.view.getDevice().getHandle();
      device.pushErrorScope('validation');
      await demo.setScene(key);
      const actors = demo.renderers[1].getActors();
      const geometry = actors.map((actor) => ({
        points: actor.getMapper().getInputData().getNumberOfPoints(),
        triangles: actor.getMapper().getInputData().getNumberOfPolys(),
        opacity: actor.getProperty().getOpacity(),
      }));
      const before = await demo.view.getPixelsAsync();
      await demo.reverseOrder();
      const after = await demo.view.getPixelsAsync();
      let changedChannels = 0;
      let foregroundPixels = 0;
      const background = demo.renderers[1]
        .getBackground()
        .slice(0, 3)
        .map((channel) => Math.round(channel * 255));
      for (let y = 0; y < before.height; y++) {
        for (let x = before.width / 2; x < before.width; x++) {
          const offset = (y * before.width + x) * 4;
          if (
            background.some(
              (value, i) => Math.abs(before.colorValues[offset + i] - value) > 2
            )
          )
            foregroundPixels++;
          for (let channel = 0; channel < 4; channel++) {
            if (
              before.colorValues[offset + channel] !==
              after.colorValues[offset + channel]
            )
              changedChannels++;
          }
        }
      }
      await demo.reverseOrder();
      const error = await device.popErrorScope();
      return {
        name: key,
        geometry,
        changedChannels,
        foregroundPixels,
        viewportPixels: (before.width * before.height) / 2,
        validationError: error?.message || null,
      };
    }, name);
    assert.equal(result.validationError, null, `${name}: GPU validation`);
    assert.equal(
      result.changedChannels,
      0,
      `${name}: draw order changed the deep image`
    );
    assert.ok(
      result.foregroundPixels > result.viewportPixels * 0.03,
      `${name}: model did not occupy the viewport`
    );
    assert.ok(
      result.foregroundPixels < result.viewportPixels * 0.95,
      `${name}: model framing must leave visible background`
    );
    assert.equal(
      result.geometry.length,
      specification.actors.length,
      `${name}: surface count`
    );
    specification.actors.forEach((actor, index) => {
      assert.equal(
        result.geometry[index].triangles,
        actor.triangleCount,
        `${name}: triangle count`
      );
      assert.equal(
        result.geometry[index].opacity,
        actor.opacity,
        `${name}: article opacity`
      );
    });
    await page.screenshot({
      path: path.join(output, `${name}.png`),
      fullPage: true,
    });
    results.push(result);
  }
  assert.deepEqual(errors, [], 'Browser errors');
  await writeFile(
    path.join(output, 'report.json'),
    `${JSON.stringify({ url, results, errors }, null, 2)}\n`
  );
  console.log(
    `Verified ${results.length} real datasets. Screenshots: ${output}`
  );
  console.log(
    JSON.stringify(
      results.map(({ name, changedChannels, geometry }) => ({
        name,
        changedChannels,
        geometry,
      })),
      null,
      2
    )
  );
} finally {
  await browser.close();
}
