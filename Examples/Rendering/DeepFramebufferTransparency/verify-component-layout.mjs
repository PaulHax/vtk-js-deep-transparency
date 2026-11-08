import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export async function inspectComponentLayout(view, name) {
  const layout = await view.locator('#legend').evaluate((legend) => {
    const bounds = legend.getBoundingClientRect();
    const rows = [...legend.querySelectorAll('.component-row')].map((row) => {
      const rect = row.getBoundingClientRect();
      const label = row.querySelector('.component-name');
      const text = label.querySelector('span').getBoundingClientRect();
      const slider = row.querySelector('input').getBoundingClientRect();
      const elements = [
        ...row.querySelectorAll('button, label, input, output'),
      ].map((element) => {
        const child = element.getBoundingClientRect();
        return {
          left: child.left - rect.left,
          right: rect.right - child.right,
          width: child.width,
          height: child.height,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        };
      });
      return {
        left: rect.left - bounds.left,
        top: rect.top - bounds.top,
        width: rect.width,
        height: rect.height,
        labelSliderGap: slider.left - text.right,
        labelCursor: getComputedStyle(label).cursor,
        elements,
      };
    });
    return {
      width: bounds.width,
      gap: parseFloat(getComputedStyle(legend).columnGap),
      rows,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
  assert.ok(layout.rows.length > 0, `${name}: component groups exist`);
  assert.ok(
    layout.documentWidth <= layout.viewportWidth,
    `${name}: no horizontal document overflow`
  );
  assert.ok(
    new Set(layout.rows.map((row) => Math.round(row.width))).size > 1,
    `${name}: group widths follow their content`
  );
  for (const row of layout.rows) {
    assert.ok(
      row.left >= -0.5 && row.left + row.width <= layout.width + 0.5,
      `${name}: component group fits the legend`
    );
    assert.ok(
      row.labelSliderGap >= -0.5 && row.labelSliderGap <= 12,
      `${name}: slider stays close to its label`
    );
    assert.notEqual(
      row.labelCursor,
      'pointer',
      `${name}: component labels use a normal cursor`
    );
    assert.equal(row.elements[0].width, 24, `${name}: compact eye width`);
    assert.equal(row.elements[0].height, 24, `${name}: compact eye height`);
    for (const element of row.elements) {
      assert.ok(
        element.left >= -0.5 && element.right >= -0.5,
        `${name}: controls fit their group`
      );
      assert.ok(
        element.scrollWidth <= element.clientWidth &&
          element.scrollHeight <= element.clientHeight,
        `${name}: names and controls are not clipped`
      );
    }
  }
  for (let i = 0; i < layout.rows.length; i++) {
    for (let j = i + 1; j < layout.rows.length; j++) {
      const a = layout.rows[i],
        b = layout.rows[j];
      const overlapX =
        Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapY =
        Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      assert.ok(
        overlapX <= 0.5 || overlapY <= 0.5,
        `${name}: wrapped groups do not overlap`
      );
    }
  }
  const requiredWidth =
    layout.rows.reduce((sum, row) => sum + row.width, 0) +
    layout.gap * (layout.rows.length - 1);
  if (requiredWidth <= layout.width + 0.5)
    assert.ok(
      layout.rows.every((row) => Math.abs(row.top - layout.rows[0].top) < 1),
      `${name}: groups share a row when their content fits`
    );
  else
    assert.ok(
      layout.rows.some((row) => row.top > layout.rows[0].top + 1),
      `${name}: groups wrap when their content needs another row`
    );
  return layout;
}

async function main() {
  const base = new URL(process.env.DEMO_URL || 'http://127.0.0.1:9999');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.search = '';
  base.hash = '';
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const output = path.resolve(
    process.env.DEMO_OUTPUT_DIR ||
      path.join(root, 'comparison/component-layout')
  );
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
  try {
    const measuring = await browser.newContext({
      viewport: { width: 1341, height: 1161 },
    });
    const gallery = await measuring.newPage();
    await gallery.route('**/*', (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame().parentFrame())
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>Layout measurement</title>',
        });
      return route.continue();
    });
    await gallery.goto(base.href);
    await gallery
      .locator('section#anatomy iframe')
      .waitFor({ state: 'attached' });
    const widths = [];
    for (const width of [1341, 1014, 390]) {
      await gallery.setViewportSize({ width, height: 1161 });
      const embeddedWidth = await gallery
        .locator('section#anatomy iframe')
        .evaluate((iframe) => Math.round(iframe.getBoundingClientRect().width));
      widths.push({ width, embeddedWidth });
    }
    await measuring.close();
    const results = [];
    for (const name of ['anatomy', 'cad']) {
      const page = await browser.newPage({
        viewport: { width: widths[0].embeddedWidth, height: 1161 },
      });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      const viewer = new URL(base);
      viewer.searchParams.set('scene', name);
      viewer.searchParams.set('embed', '1');
      await page.goto(viewer.href);
      await page.waitForFunction(() => globalThis.demo);
      await page.evaluate(() => globalThis.demo.ready);
      const canvas = page.locator('#viewport canvas');
      const original = await canvas.screenshot();
      await page.locator('#component-0').click();
      await page.evaluate(() => globalThis.demo.render());
      assert.notDeepEqual(
        await canvas.screenshot(),
        original,
        `${name}: eye button changes the model`
      );
      await page.locator('#component-0').click();
      await page.evaluate(() => globalThis.demo.render());
      assert.deepEqual(
        await canvas.screenshot(),
        original,
        `${name}: eye button restores exact pixels`
      );
      const opacity = Number(
        await page.locator('#component-opacity-0').inputValue()
      );
      await page.locator('#component-opacity-0').press('Home');
      await page.evaluate(() => globalThis.demo.render());
      assert.notDeepEqual(
        await canvas.screenshot(),
        original,
        `${name}: opacity changes the model`
      );
      await page.evaluate(
        (value) => globalThis.demo.setComponentOpacity(0, value),
        opacity
      );
      assert.deepEqual(
        await canvas.screenshot(),
        original,
        `${name}: opacity restores exact pixels`
      );
      const camera = () =>
        page.evaluate(() => ({
          position: [...globalThis.demo.camera.getPosition()],
          focal: [...globalThis.demo.camera.getFocalPoint()],
          up: [...globalThis.demo.camera.getViewUp()],
          scale: globalThis.demo.camera.getParallelScale(),
        }));
      const initial = await camera();
      await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width * 0.75 + 60,
        box.y + box.height / 2 - 35,
        { steps: 8 }
      );
      await page.mouse.up();
      await page.evaluate(() => globalThis.demo.controls.whenIdle());
      assert.notDeepEqual(
        await camera(),
        initial,
        `${name}: drag rotates the camera`
      );
      await page.locator('#reset').click();
      await page.evaluate(() => globalThis.demo.render());
      assert.deepEqual(
        await camera(),
        initial,
        `${name}: reset restores the camera`
      );
      assert.deepEqual(
        await canvas.screenshot(),
        original,
        `${name}: reset restores exact pixels`
      );
      for (const size of widths) {
        await page.setViewportSize({ width: size.embeddedWidth, height: 1161 });
        await page.evaluate(async () => {
          await globalThis.demo.render();
          await globalThis.demo.resetCamera();
        });
        const layout = await inspectComponentLayout(
          page,
          `${name} at ${size.width}`
        );
        if (name === 'cad' && size.width === 1341)
          assert.ok(
            layout.rows.every(
              (row) => Math.abs(row.top - layout.rows[0].top) < 1
            ),
            'All four bearing components fit across the wide view'
          );
        await page
          .locator('.laboratory')
          .screenshot({ path: path.join(output, `${name}-${size.width}.png`) });
        if (name === 'anatomy' && size.width === 1341)
          await page
            .locator('#reset')
            .screenshot({ path: path.join(output, 'reset-icon.png') });
        results.push({
          name,
          ...size,
          layout,
          exactControlRestoration: true,
          resetButton: true,
        });
      }
      await page.close();
    }
    assert.deepEqual(errors, [], 'Browser or WebGPU errors');
    await writeFile(
      path.join(output, 'report.json'),
      `${JSON.stringify({ url: base.href, results, errors }, null, 2)}\n`
    );
    console.log(
      `Component wrapping verification passed. Screenshots and report: ${output}`
    );
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
