import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseURL = new URL(process.env.DEMO_URL || 'http://127.0.0.1:9999');
if (!baseURL.pathname.endsWith('/')) baseURL.pathname += '/';
baseURL.search = '';
baseURL.hash = '';
const url = baseURL.href;

const output = path.resolve(
  process.env.DEMO_OUTPUT_DIR || '/tmp/deep-transparency-controls'
);
await mkdir(output, { recursive: true });
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
  const picking = await page.evaluate(async () => {
    const { demo } = globalThis;
    const selector = demo.view.createSelector();
    selector.setCaptureZValues(true);
    const pick = async () => {
      selector.attach(demo.view, demo.renderers[1]);
      const source = await selector.getSourceDataAsync();
      const display = demo.view.worldToDisplay(0, 0, 0, demo.renderers[1]);
      const x = Math.floor(display[0]);
      const y = Math.floor(display[1]);
      const nodes = source.generateSelection(x, y, x, y);
      return nodes.map((node) => ({
        actor: demo.scenes.layers.actors.indexOf(node.getProperties().prop),
        world: [...node.getProperties().worldPosition],
      }));
    };
    const redFront = await pick();
    await demo.reverseOrder();
    const reversed = await pick();
    await demo.swapDepths();
    const blueFront = await pick();
    await demo.setComponentVisibility(1, false);
    const hidden = await pick();
    await demo.setComponentVisibility(1, true);
    await demo.swapDepths();
    await demo.reverseOrder();
    selector.delete();
    await demo.render();
    return { redFront, reversed, blueFront, hidden };
  });
  for (const [name, actor, z] of [
    ['redFront', 0, 0.2],
    ['reversed', 0, 0.2],
    ['blueFront', 1, 0.2],
    ['hidden', 0, -0.2],
  ]) {
    assert.equal(
      picking[name].length,
      1,
      `${name}: picker missed translucent surfaces`
    );
    assert.equal(
      picking[name][0].actor,
      actor,
      `${name}: picker did not select the nearest visible actor`
    );
    assert(
      Math.abs(picking[name][0].world[2] - z) < 1e-5,
      `${name}: picker did not respect surface depth or actor transforms`
    );
  }
  const canvas = page.locator('#viewport canvas');
  const viewBounds = async () => {
    await canvas.scrollIntoViewIfNeeded();
    const rect = await canvas.boundingBox();
    assert.ok(rect, 'The canvas is visible before pointer interaction');
    return {
      rect,
      center: {
        x: rect.x + rect.width * 0.75,
        y: rect.y + rect.height * 0.5,
      },
      radius: Math.min(rect.width / 2, rect.height) / 2,
    };
  };
  const idle = () => page.evaluate(() => globalThis.demo.controls.whenIdle());
  const resetView = async () => {
    await page.locator('#reset').click();
    await idle();
    return viewBounds();
  };
  const screenshot = (name) =>
    canvas.screenshot({ path: path.join(output, name) });
  const state = () =>
    page.evaluate(() => {
      const { demo } = globalThis;
      return {
        position: [...demo.camera.getPosition()],
        focal: [...demo.camera.getFocalPoint()],
        up: [...demo.camera.getViewUp()],
        scale: demo.camera.getParallelScale(),
        projected: demo.renderers.map((renderer) =>
          demo.view.worldToDisplay(0.3, 0.25, 0.2, renderer)
        ),
      };
    });
  const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
  const { center } = await viewBounds();
  const before = await state();
  const initialPixels = await screenshot('01-initial.png');
  await page.mouse.move(center.x, center.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(center.x + 85, center.y - 55, { steps: 12 });
  await page.mouse.up({ button: 'left' });
  await idle();
  const rotated = await state();
  assert(
    distance(before.position, rotated.position) > 1,
    'Left drag did not rotate the camera'
  );
  assert(
    distance(before.focal, rotated.focal) < 1e-10,
    'Arcball changed the orbit center'
  );
  assert(
    Math.abs(
      distance(before.position, before.focal) -
        distance(rotated.position, rotated.focal)
    ) < 1e-9
  );
  assert(
    !initialPixels.equals(await screenshot('02-arcball-rotation.png')),
    'Rotation did not change the rendered image'
  );

  // The sphere mapping depends on the endpoints rather than the event path.
  const { center: detourCenter } = await resetView();
  await page.mouse.move(detourCenter.x, detourCenter.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(detourCenter.x - 45, detourCenter.y + 70);
  await page.mouse.move(detourCenter.x + 85, detourCenter.y - 55);
  await page.mouse.up({ button: 'left' });
  await idle();
  const detour = await state();
  assert(
    distance(rotated.position, detour.position) < 1e-10,
    'Arcball rotation depended on the pointer path'
  );
  assert(
    distance(rotated.up, detour.up) < 1e-10,
    'Arcball roll depended on the pointer path'
  );

  const { center: rollCenter, radius: rollRadius } = await resetView();
  await page.mouse.move(rollCenter.x + rollRadius * 0.9, rollCenter.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(rollCenter.x, rollCenter.y - rollRadius * 0.9);
  await page.mouse.up({ button: 'left' });
  await idle();
  const rolled = await state();
  assert(
    Math.abs(rolled.up[0]) > 0.5,
    'Arcball failed to produce free roll around the viewport rim'
  );
  await screenshot('03-arcball-roll.png');

  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalized = (value) => {
    const magnitude = Math.hypot(...value);
    return value.map((coordinate) => coordinate / magnitude);
  };
  const axes = (value) => {
    const back = normalized(
      value.position.map((coordinate, i) => coordinate - value.focal[i])
    );
    const right = normalized(cross(value.up, back));
    return [right, cross(back, right), back];
  };
  const angularDistance = (a, b) => {
    const from = axes(a);
    const trace = axes(b).reduce((sum, axis, i) => sum + dot(axis, from[i]), 0);
    return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  };
  await page.evaluate(() => {
    globalThis.observedArcballPointer = null;
    globalThis.demo.view
      .getCanvas()
      .addEventListener('pointermove', (event) => {
        globalThis.observedArcballPointer = [event.clientX, event.clientY];
      });
  });
  const edgeChecks = [];
  for (const viewport of [0, 1]) {
    for (const [edge, dx, dy] of [
      ['left', -1, 0],
      ['right', 1, 0],
      ['top', 0, -1],
      ['bottom', 0, 1],
    ]) {
      const { rect, center: edgeCenter, radius } = await resetView();
      const paneCenter = {
        x: rect.x + rect.width * (viewport / 2 + 0.25),
        y: edgeCenter.y,
      };
      const transition = radius / Math.SQRT2;
      const paneExtent = dx === 0 ? rect.height / 2 : rect.width / 4;
      const radialPositions = [
        transition - 2,
        transition - 1,
        transition,
        transition + 1,
        transition + 2,
        ...Array.from({ length: 9 }, (_, index) => radius + index - 4),
        radius + 20,
        radius + 60,
        Math.max(radius + 80, paneExtent + 24),
        radius + 4,
        radius + 1,
        radius - 1,
        radius - 4,
      ];
      await page.mouse.move(
        paneCenter.x + dx * radialPositions[0],
        paneCenter.y + dy * radialPositions[0]
      );
      await page.mouse.down({ button: 'left' });
      let previous = await state();
      let previousPointer = await page.evaluate(
        () => globalThis.observedArcballPointer
      );
      let maximumRadiansPerPixel = 0;
      for (const radialPosition of radialPositions.slice(1)) {
        await page.mouse.move(
          paneCenter.x + dx * radialPosition,
          paneCenter.y + dy * radialPosition
        );
        await idle();
        const current = await state();
        const pointer = await page.evaluate(
          () => globalThis.observedArcballPointer
        );
        const moved = distance(previousPointer, pointer);
        const angle = angularDistance(previous, current);
        // The normalized lift has slope at most sqrt(2); an endpoint
        // quaternion turns the camera by at most twice that spherical angle.
        const bound = (2 * Math.SQRT2 * moved) / radius;
        assert(
          angle <= bound + 1e-6,
          `${viewport}/${edge}: ${moved}px pointer step rotated ${angle} radians, above ${bound}`
        );
        if (moved > 0)
          maximumRadiansPerPixel = Math.max(
            maximumRadiansPerPixel,
            angle / moved
          );
        assert(
          distance(before.focal, current.focal) < 1e-10,
          'Rim drag changed the orbit center'
        );
        assert(
          Math.abs(
            distance(current.position, current.focal) -
              distance(before.position, before.focal)
          ) < 1e-9,
          'Rim drag changed the orbit distance'
        );
        previous = current;
        previousPointer = pointer;
      }
      await page.mouse.up({ button: 'left' });
      await idle();
      edgeChecks.push({
        viewport,
        edge,
        maximumRadiansPerPixel,
        boundRadiansPerPixel: (2 * Math.SQRT2) / radius,
      });
    }
  }
  await screenshot('06-smooth-rim.png');

  const { center: panCenter } = await resetView();
  const panBefore = await state();
  await page.mouse.move(panCenter.x, panCenter.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(panCenter.x + 56, panCenter.y + 32, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await idle();
  const panned = await state();
  assert(
    distance(panBefore.up, panned.up) < 1e-10,
    'Right drag changed camera roll'
  );
  const direction = (value) =>
    value.position.map((coordinate, i) => coordinate - value.focal[i]);
  assert(
    distance(direction(panBefore), direction(panned)) < 1e-10,
    'Right drag rotated the camera'
  );
  for (let viewport = 0; viewport < 2; viewport++) {
    assert(
      Math.abs(
        panned.projected[viewport][0] - panBefore.projected[viewport][0] - 56
      ) < 1e-6,
      'Pan did not follow the pointer horizontally'
    );
    assert(
      Math.abs(
        panned.projected[viewport][1] - panBefore.projected[viewport][1] + 32
      ) < 1e-6,
      'Pan did not follow the pointer vertically'
    );
  }
  await screenshot('04-right-pan.png');

  const zoomChecks = [];
  for (const perspective of [false, true]) {
    for (const viewport of [0, 1]) {
      await resetView();
      await page.evaluate(async (usePerspective) => {
        globalThis.demo.camera.setParallelProjection(!usePerspective);
        globalThis.demo.camera.setViewAngle(35);
        await globalThis.demo.render();
      }, perspective);
      const pointer = await page.evaluate((index) => {
        const { demo } = globalThis;
        const display = demo.view.worldToDisplay(
          0.3,
          0.25,
          0.2,
          demo.renderers[index]
        );
        const bounds = demo.view.getCanvas().getBoundingClientRect();
        const [width, height] = demo.view.getSize();
        return {
          x: bounds.left + (display[0] * bounds.width) / width,
          y: bounds.bottom - (display[1] * bounds.height) / height,
        };
      }, viewport);
      await page.mouse.move(pointer.x, pointer.y);
      await page.mouse.click(pointer.x, pointer.y);
      assert.equal(
        await canvas.evaluate(
          (element) => element.ownerDocument.activeElement === element
        ),
        true,
        'Clicking the canvas focuses wheel zoom'
      );
      await page.evaluate((index) => {
        const { demo } = globalThis;
        globalThis.observedWheel = new Promise((resolve) => {
          demo.view.getCanvas().addEventListener(
            'wheel',
            (event) => {
              const bounds = demo.view.getCanvas().getBoundingClientRect();
              const [width, height] = demo.view.getSize();
              const x = ((event.clientX - bounds.left) * width) / bounds.width;
              const y =
                ((bounds.bottom - event.clientY) * height) / bounds.height;
              const renderer = demo.renderers[index];
              const depth = demo.view.worldToDisplay(0, 0, 0.2, renderer)[2];
              const world = demo.view.displayToWorld(x, y, depth, renderer);
              resolve({ world: [...world], display: [x, y], viewport: index });
            },
            { once: true }
          );
        });
      }, viewport);
      await page.mouse.wheel(0, -180);
      const anchor = await page.evaluate(() => globalThis.observedWheel);
      await idle();
      const result = await page.evaluate(({ world, viewport: index }) => {
        const { demo } = globalThis;
        return {
          display: demo.view.worldToDisplay(...world, demo.renderers[index]),
          parallelScale: demo.camera.getParallelScale(),
          position: [...demo.camera.getPosition()],
        };
      }, anchor);
      const anchorErrorPixels = Math.hypot(
        result.display[0] - anchor.display[0],
        result.display[1] - anchor.display[1]
      );
      assert(
        anchorErrorPixels < 0.01,
        `Zoom moved the surface under the pointer by ${anchorErrorPixels}px`
      );
      assert(
        result.position[2] < 6,
        'Wheel up did not move toward the surface under the pointer'
      );
      zoomChecks.push({ perspective, viewport, anchorErrorPixels });
    }
  }
  await screenshot('05-cursor-zoom.png');
  const pendingZoomChecks = [];
  for (const refocus of [false, true]) {
    const { center: pendingCenter } = await resetView();
    await page.mouse.click(pendingCenter.x, pendingCenter.y);
    const previous = await state();
    await page.evaluate((refocusCanvas) => {
      const element = globalThis.demo.view.getCanvas();
      element.addEventListener(
        'wheel',
        () => {
          document.querySelector('#reset').focus();
          if (refocusCanvas) element.focus({ preventScroll: true });
        },
        { once: true }
      );
    }, refocus);
    await page.mouse.wheel(0, -80);
    await idle();
    assert.deepEqual(
      await state(),
      previous,
      'Losing focus cancels a pending zoom, including after immediate refocus'
    );
    pendingZoomChecks.push({
      refocusedBeforePickCompletion: refocus,
      cameraUnchanged: true,
    });
  }
  assert.deepEqual(errors, [], 'Browser reported an error');
  const report = {
    picking,
    rotation: true,
    endpointIndependent: true,
    freeRoll: true,
    edgeChecks,
    linkedPan: true,
    zoomChecks,
    pendingZoomChecks,
    errors,
  };
  await writeFile(
    path.join(output, 'controls.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
