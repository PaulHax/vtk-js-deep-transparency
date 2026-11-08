import { it, expect } from 'vitest';
import { page } from 'vitest/browser';
import vtkActor from 'vtk.js/Sources/Rendering/Core/Actor';
import vtkMapper from 'vtk.js/Sources/Rendering/Core/Mapper';
import vtkPolyData from 'vtk.js/Sources/Common/DataModel/PolyData';
import vtkRenderer from 'vtk.js/Sources/Rendering/Core/Renderer';
import vtkRenderWindow from 'vtk.js/Sources/Rendering/Core/RenderWindow';
import testUtils from 'vtk.js/Sources/Testing/testUtils';
import 'vtk.js/Sources/Rendering/Misc/RenderingAPIs';

import specification from './scenes.json';
import meshes from './meshes.json';
import redFront from './baselines/red-front.png';
import blueFront from './baselines/blue-front.png';
import crossing from './baselines/crossing.png';
import opaqueOccluder from './baselines/opaque-occluder.png';
import nestedSpheres from './baselines/nested-spheres.png';
import intersectingSpheres from './baselines/intersecting-spheres.png';

const baselines = {
  'red-front': redFront,
  'blue-front': blueFront,
  crossing,
  'opaque-occluder': opaqueOccluder,
  'nested-spheres': nestedSpheres,
  'intersecting-spheres': intersectingSpheres,
};
const webGPU = it.skipIf(!__VTK_TEST_WEBGPU__);

function createLayer(gc, layer) {
  const data = gc.registerResource(vtkPolyData.newInstance());
  if (layer.mesh) {
    const mesh = meshes[layer.mesh];
    data.getPoints().setData(new Float32Array(mesh.points), 3);
    data.getPolys().setData(new Uint32Array(mesh.triangles));
  } else {
    const [xmin, xmax, ymin, ymax] = layer.bounds;
    const depth = layer.depth ?? 0;
    const slope = layer.slope ?? 0;
    const points = [
      [xmin, ymin],
      [xmax, ymin],
      [xmax, ymax],
      [xmin, ymax],
    ].flatMap(([x, y]) => [x, y, depth + slope * x]);
    data.getPoints().setData(new Float32Array(points), 3);
    data.getPolys().setData(new Uint32Array([3, 0, 1, 2, 3, 0, 2, 3]));
  }
  const mapper = gc.registerResource(vtkMapper.newInstance());
  mapper.setInputData(data);
  mapper.setScalarVisibility(false);
  const actor = gc.registerResource(vtkActor.newInstance());
  actor.setMapper(mapper);
  actor.getProperty().setColor(...layer.color);
  actor.getProperty().setOpacity(layer.opacity);
  actor.getProperty().setLighting(false);
  return actor;
}

function createScene(gc, layers, { samples = 1, viewport } = {}) {
  const container = gc.registerDOMElement(document.createElement('div'));
  container.style.width = `${specification.size}px`;
  container.style.height = `${specification.size}px`;
  document.body.appendChild(container);
  const renderWindow = gc.registerResource(vtkRenderWindow.newInstance());
  const renderer = gc.registerResource(vtkRenderer.newInstance());
  renderer.setUseDeepFramebufferTransparency(true);
  renderer.setBackground(...specification.background);
  if (viewport) renderer.setViewport(...viewport);
  renderWindow.addRenderer(renderer);
  const actors = layers.map((layer) => createLayer(gc, layer));
  actors.forEach(renderer.addActor);
  const camera = renderer.getActiveCamera();
  camera.setParallelProjection(true);
  camera.setPosition(...specification.camera.position);
  camera.setFocalPoint(...specification.camera.focalPoint);
  camera.setViewUp(...specification.camera.viewUp);
  camera.setParallelScale(specification.camera.parallelScale);
  camera.setClippingRange(...specification.camera.clippingRange);
  const view = gc.registerResource(renderWindow.newAPISpecificView('WebGPU'));
  view.setContainer(container);
  view.setMultiSample(samples);
  view.setSize(specification.size, specification.size);
  renderWindow.addView(view);
  const capture = async () => {
    const configuration = view.getWebGPUConfiguration();
    expect(await configuration.initialize()).toBe(true);
    const device = configuration.getDevice();
    device.pushErrorScope('validation');
    const image = view.captureNextImage();
    renderWindow.render();
    const captured = await image;
    await device.queue.onSubmittedWorkDone();
    const error = await device.popErrorScope();
    expect(error?.message ?? null, 'WebGPU validation').toBe(null);
    return testUtils.getImageDataFromURI(captured);
  };
  return { renderWindow, renderer, actors, view, capture };
}

function pixelAt(image, x, y) {
  const offset = 4 * (y * image.width + x);
  return Array.from(image.data.slice(offset, offset + 4));
}

function expectImageChannels(actual, reference, maxChannelError = 0) {
  expect([actual.width, actual.height]).toEqual([
    reference.width,
    reference.height,
  ]);
  let differingChannels = 0;
  let maximumError = 0;
  for (let i = 0; i < actual.data.length; i++) {
    const error = Math.abs(actual.data[i] - reference.data[i]);
    if (error > maxChannelError) differingChannels++;
    maximumError = Math.max(maximumError, error);
  }
  expect(
    differingChannels,
    `${differingChannels} channels exceeded ${maxChannelError}; maximum error ${maximumError}`
  ).toBe(0);
}

function expectCurvedReference(actual, reference) {
  expect([actual.width, actual.height]).toEqual([
    reference.width,
    reference.height,
  ]);
  let stablePixels = 0;
  let invalidPixels = 0;
  for (let y = 0; y < reference.height; y++) {
    for (let x = 0; x < reference.width; x++) {
      const expected = pixelAt(reference, x, y);
      const observed = pixelAt(actual, x, y);
      const neighbors = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (
            x + dx >= 0 &&
            x + dx < reference.width &&
            y + dy >= 0 &&
            y + dy < reference.height
          ) {
            neighbors.push(pixelAt(reference, x + dx, y + dy));
          }
        }
      }
      const distance = (a, b) =>
        Math.max(...a.map((channel, i) => Math.abs(channel - b[i])));
      const boundary = neighbors.some(
        (neighbor) => distance(neighbor, expected) > 1
      );
      if (!boundary) stablePixels++;
      const allowedColors = boundary ? neighbors : [expected];
      if (
        observed[3] !== expected[3] ||
        !allowedColors.some((color) => distance(observed, color) <= 1)
      ) {
        invalidPixels++;
      }
    }
  }
  expect(
    stablePixels,
    'at least 90% of the image is checked without a spatial margin'
  ).toBeGreaterThan(reference.width * reference.height * 0.9);
  expect(
    invalidPixels,
    'interiors agree within one channel level; boundary colors stay within one native pixel'
  ).toBe(0);
}

for (const name of Object.keys(baselines)) {
  const curved = name.endsWith('spheres');
  const comparison = curved
    ? 'matches native C++ compositing with a one-pixel raster boundary margin'
    : 'matches native C++ depth peeling exactly';
  webGPU(`Deep framebuffer ${comparison}: ${name}`, async () => {
    const gc = testUtils.createGarbageCollector();
    try {
      const { capture } = createScene(gc, specification.scenes[name]);
      const actual = await capture();
      const reference = await testUtils.getImageDataFromURI(baselines[name]);
      if (curved) expectCurvedReference(actual, reference);
      else expectImageChannels(actual, reference);
    } finally {
      gc.releaseResources();
    }
  });
}

webGPU(
  'Deep framebuffer sorts intersecting surfaces independently of actor order',
  async () => {
    const gc = testUtils.createGarbageCollector();
    try {
      const { renderer, actors, capture } = createScene(
        gc,
        specification.scenes.crossing
      );
      const original = await capture();
      actors.forEach(renderer.removeActor);
      actors.toReversed().forEach(renderer.addActor);
      expectImageChannels(await capture(), original);
      expect(pixelAt(original, 96, 128)).toEqual([64, 0, 128, 255]);
      expect(pixelAt(original, 160, 128)).toEqual([128, 0, 64, 255]);
    } finally {
      gc.releaseResources();
    }
  }
);

webGPU(
  'Deep framebuffer retains the nearest sixteen of twenty layers',
  async () => {
    const gc = testUtils.createGarbageCollector();
    try {
      const layers = Array.from({ length: 20 }, (_, index) => ({
        bounds: [-0.125, 0.125, -0.125, 0.125],
        depth: 0.9 - index * 0.08,
        color: index % 2 ? [0, 0, 1] : [1, 0, 0],
        opacity: 0.125,
      }));
      const { renderer, actors, capture } = createScene(
        gc,
        layers.toReversed()
      );
      const image = await capture();
      const alpha = 32 / 255;
      const color = layers
        .slice(0, 16)
        .toReversed()
        .reduce(
          (behind, layer) =>
            layer.color.map(
              (channel, i) => channel * alpha + behind[i] * (1 - alpha)
            ),
          [0, 0, 0]
        )
        .map((channel) => Math.round(channel * 255));
      expect(pixelAt(image, 128, 128)).toEqual([...color, 255]);
      actors.forEach(renderer.removeActor);
      actors.toReversed().forEach(renderer.addActor);
      expectImageChannels(await capture(), image);
    } finally {
      gc.releaseResources();
    }
  }
);

webGPU(
  'Deep framebuffer clears old fragments after opacity changes and resize',
  async () => {
    const gc = testUtils.createGarbageCollector();
    try {
      const { actors, view, capture } = createScene(
        gc,
        specification.scenes['red-front']
      );
      expect(pixelAt(await capture(), 128, 128)).toEqual([128, 0, 64, 255]);
      view.setSize(320, 192);
      const resized = await capture();
      expect([resized.width, resized.height]).toEqual([320, 192]);
      expect(pixelAt(resized, 160, 96)).toEqual([128, 0, 64, 255]);
      actors[0].getProperty().setOpacity(0);
      expect(pixelAt(await capture(), 160, 96)).toEqual([0, 0, 128, 255]);
      actors[1].getProperty().setOpacity(0);
      expect(pixelAt(await capture(), 160, 96)).toEqual([0, 0, 0, 255]);
      actors.forEach((actor) => actor.getProperty().setOpacity(0.5));
      view.setSize(256, 256);
      expectImageChannels(
        await capture(),
        await testUtils.getImageDataFromURI(redFront)
      );
    } finally {
      gc.releaseResources();
    }
  }
);

webGPU('Deep framebuffer respects renderer viewport bounds', async () => {
  const gc = testUtils.createGarbageCollector();
  try {
    const { capture } = createScene(gc, specification.scenes['red-front'], {
      viewport: [0.5, 0, 1, 1],
    });
    const image = await capture();
    expect(pixelAt(image, 192, 128)).toEqual([128, 0, 64, 255]);
    let escapedChannels = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width / 2; x++) {
        escapedChannels += pixelAt(image, x, y)
          .slice(0, 3)
          .filter(Boolean).length;
      }
    }
    expect(escapedChannels).toBe(0);
  } finally {
    gc.releaseResources();
  }
});

webGPU(
  'Deep framebuffer updates canvas content when switching sample counts',
  async () => {
    const gc = testUtils.createGarbageCollector();
    try {
      const { actors, view, capture } = createScene(
        gc,
        specification.scenes['opaque-occluder'],
        { samples: 4 }
      );
      const canvasPixels = async () => {
        const screenshot = await page.screenshot({
          element: view.getCanvas(),
          save: false,
          base64: true,
        });
        return testUtils.getImageDataFromURI(
          `data:image/png;base64,${typeof screenshot === 'string' ? screenshot : screenshot.base64}`
        );
      };
      const multisampled = await capture();
      expect(pixelAt(multisampled, 128, 128)).toEqual([128, 127, 0, 255]);
      expect(pixelAt(await canvasPixels(), 128, 128)).toEqual([
        128, 127, 0, 255,
      ]);
      view.setMultiSample(1);
      actors[0].getProperty().setColor(0, 0, 1);
      expect(pixelAt(await capture(), 128, 128)).toEqual([0, 127, 128, 255]);
      expect(pixelAt(await canvasPixels(), 128, 128)).toEqual([
        0, 127, 128, 255,
      ]);
      view.setMultiSample(4);
      actors[0].getProperty().setColor(1, 0, 0);
      actors[0].getProperty().setOpacity(0.25);
      expect(pixelAt(await capture(), 128, 128)).toEqual([64, 191, 0, 255]);
      expect(pixelAt(await canvasPixels(), 128, 128)).toEqual([
        64, 191, 0, 255,
      ]);
    } finally {
      gc.releaseResources();
    }
  }
);

webGPU(
  'Deep framebuffer honors property opacity with the default alpha mode',
  async () => {
    const gc = testUtils.createGarbageCollector();
    try {
      const { actors, capture } = createScene(
        gc,
        specification.scenes['red-front']
      );
      expect(pixelAt(await capture(), 128, 128)).toEqual([128, 0, 64, 255]);
      actors[0].getProperty().setOpacity(0.25);
      expect(pixelAt(await capture(), 128, 128)).toEqual([64, 0, 96, 255]);
    } finally {
      gc.releaseResources();
    }
  }
);
