import '@kitware/vtk.js/Rendering/WebGPU/Profiles/Geometry';
import vtkCamera from '@kitware/vtk.js/Rendering/Core/Camera';
import vtkLight from '@kitware/vtk.js/Rendering/Core/Light';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkWebGPURenderWindow from '@kitware/vtk.js/Rendering/WebGPU/RenderWindow';
import { createScenes } from './geometry';
import { createArcballControls } from './arcball.js';
import { createDatasetLoader, datasetChoices } from './dataset-loader';
import './style.css';

const scenes = createScenes();
const embedded = new URLSearchParams(location.search).has('embed');
document.body.classList.toggle('embedded', embedded);

document.body.innerHTML = `
  <main class="laboratory">
    <header class="masthead">
      <div class="brand"><strong>VTK.js</strong> Rendering laboratory / 01</div>
      <div class="status" role="status" id="status">Preparing WebGPU</div>
    </header>
    <section class="intro" aria-labelledby="title">
      <div>
        <p class="eyebrow">Order-independent transparency</p>
        <h1 id="title">Transparency, in depth.</h1>
      </div>
      <p class="intro-copy">Look inside overlapping surfaces. The same geometry, camera and materials, with two ways to combine transparent layers.</p>
    </section>
    <section class="dataset-bar" aria-label="Scientific datasets">
      <label for="scene">Scene <select id="scene"><optgroup label="Procedural examples">${Object.entries(
        scenes
      )
        .map(([key, { name }]) => `<option value="${key}">${name}</option>`)
        .join(
          ''
        )}</optgroup><optgroup label="Scientific datasets">${datasetChoices.map(({ key, name }) => `<option value="${key}">${name}</option>`).join('')}</optgroup></select></label>
      <div class="dataset-status" role="status"><span id="dataset-message">Original scan and simulation surfaces</span><button type="button" class="action" id="retry" hidden>Retry loading</button></div>
    </section>
    <section class="controls" aria-label="Scene controls">
      <label class="opacity-control" for="opacity">Opacity <input id="opacity" type="range" min="0.05" max="0.95" step="0.01" value="0.2"><output for="opacity" id="opacity-value">20%</output></label>
      <button type="button" class="action" id="reverse">Reverse draw order</button>
      <button type="button" class="action" id="swap" disabled>Swap depths</button>
      <button type="button" class="action" id="reset">Reset view</button>
    </section>
    <section class="comparison" aria-label="Transparency comparison">
      <div class="view-labels">
        <div class="view-label"><span class="method-dot"></span>Weighted blend<span class="method-type">Depth-weighted average</span></div>
        <div class="view-label deep"><span class="method-dot"></span>Deep framebuffer<span class="method-type">Sorted alpha composition</span></div>
      </div>
      <div class="viewport" id="viewport" aria-label="Interactive 3D comparison">
        <div class="interaction-hint"><span></span>Left drag rotates · Right drag pans · Wheel zooms at cursor</div>
        <div class="error" id="error" hidden></div>
      </div>
      <div class="scene-info"><p id="description"></p><div class="legend" id="legend"></div></div>
      <div class="dataset-credit" id="dataset-credit" aria-label="Model attribution">
        <div><p id="credit"></p><p id="attribution-note" hidden></p><p id="mirror-credit" hidden></p></div>
        <div class="credit-links"><a id="source" target="_blank" rel="noreferrer" hidden>Dataset source ↗</a><a id="license" target="_blank" rel="noreferrer" hidden></a></div>
      </div>
    </section>
    <section class="explanation" aria-label="How the comparison works">
      <div><h2><span class="label">01</span> Averaging loses the order</h2><p>Weighted transparency combines contributions into a few image buffers. Surfaces at different depths can blend into the same color, obscuring what lies in front.</p></div>
      <div><h2><span class="label">02</span> Keep the fragments, then sort</h2><p id="note"></p></div>
    </section>
    <footer class="footer"><span>WebGPU · Polygonal surfaces · Up to 16 retained fragments per pixel</span><a href="https://www.kitware.com/better-transparency-with-vtk-and-webgpu/" target="_blank" rel="noreferrer">Inspired by VTK's deep framebuffer ↗</a></footer>
  </main>
`;

const container = document.querySelector('#viewport');
const status = document.querySelector('#status');
const opacityControl = document.querySelector('#opacity');
const opacityValue = document.querySelector('#opacity-value');
const swapButton = document.querySelector('#swap');
const datasets = createDatasetLoader();
const sceneSelect = document.querySelector('#scene');
const datasetMessage = document.querySelector('#dataset-message');
const retryButton = document.querySelector('#retry');
const lightDefinitions = [
  { position: [4, 5, 7], intensity: 0.7, color: [1, 0.94, 0.86] },
  { position: [-5, 1, 3], intensity: 0.3, color: [0.67, 0.82, 1] },
  { position: [0, -4, -4], intensity: 0.5, color: [0.69, 1, 0.93] },
];
const camera = vtkCamera.newInstance({ parallelProjection: true });
const renderWindow = vtkRenderWindow.newInstance();
const view = vtkWebGPURenderWindow.newInstance({ multiSample: 1 });
renderWindow.addView(view);
view.setContainer(container);
view
  .getCanvas()
  .setAttribute(
    'aria-label',
    'Weighted transparency on the left and deep framebuffer on the right'
  );
const renderers = [false, true].map((useDeepFramebufferTransparency, i) => {
  const renderer = vtkRenderer.newInstance({ useDeepFramebufferTransparency });
  renderer.setViewport(i / 2, 0, (i + 1) / 2, 1);
  renderer.setActiveCamera(camera);
  lightDefinitions.forEach((light) =>
    renderer.addLight(vtkLight.newInstance(light))
  );
  renderWindow.addRenderer(renderer);
  return renderer;
});

let sceneKey = 'nested';
let reversed = false;
let depthsSwapped = false;
let initialized = false;
let selectionRequest = null;
let failedDataset = null;

const render = async () => {
  if (!initialized) return;
  renderers.forEach((renderer) => renderer.resetCameraClippingRange());
  renderWindow.render();
  await view.getDevice().getHandle().queue.onSubmittedWorkDone();
};

const controls = createArcballControls({ view, renderers, camera, render });

const showError = (message) => {
  status.textContent = 'WebGPU unavailable';
  const error = document.querySelector('#error');
  const heading = document.createElement('h2');
  heading.textContent = 'A WebGPU browser is needed';
  const detail = document.createElement('p');
  detail.textContent = message;
  error.replaceChildren(heading, detail);
  error.hidden = false;
};

const installActors = () => {
  const actors = reversed
    ? [...scenes[sceneKey].actors].reverse()
    : scenes[sceneKey].actors;
  renderers.forEach((renderer) => {
    renderer.removeAllViewProps();
    actors.forEach((actor) => renderer.addActor(actor));
  });
};

const resetCamera = () => {
  controls.cancel();
  const scene = scenes[sceneKey];
  camera.setPosition(...scene.position);
  camera.setFocalPoint(...(scene.center || [0, 0, 0]));
  camera.setViewUp(...(scene.viewUp || [0, 1, 0]));
  camera.setParallelProjection(true);
  if (scene.bounds && !scene.parallelScale)
    renderers[0].resetCamera(scene.bounds);
  else camera.setParallelScale(scene.parallelScale);
  return render();
};

const applyOpacity = (opacity) => {
  const value = Math.min(0.95, Math.max(0.05, Number(opacity)));
  const scene = scenes[sceneKey];
  scene.controlledActors.forEach((i) =>
    scene.actors[i].getProperty().setOpacity(value)
  );
  opacityControl.value = value;
  opacityValue.value = `${Math.round(value * 100)}%`;
};

const setOpacity = (opacity) => {
  applyOpacity(opacity);
  return render();
};

const setComponentVisibility = (index, visible) => {
  const actor = scenes[sceneKey].actors[index];
  if (!actor) throw new Error(`Unknown component: ${index}`);
  actor.setVisibility(Boolean(visible));
  const checkbox = document.querySelector(`#component-${index}`);
  if (checkbox) checkbox.checked = actor.getVisibility();
  return render();
};

const activateScene = (key, scene) => {
  scenes[key] = scene;
  sceneKey = key;
  installActors();
  renderers.forEach((renderer) => renderer.setBackground(...scene.background));
  sceneSelect.value = key;
  swapButton.disabled = key !== 'layers';
  renderers.forEach((renderer) => {
    renderer.getLights().forEach((light, i) => {
      const center = scene.center || [0, 0, 0];
      light.setPosition(
        ...lightDefinitions[i].position.map(
          (coordinate, axis) => center[axis] + coordinate * (scene.radius || 1)
        )
      );
      light.setFocalPoint(...center);
    });
  });
  document.querySelector('#description').textContent = scene.description;
  document.querySelector('#note').textContent = scene.note;
  document.querySelector('#legend').replaceChildren(
    ...scene.legend.map(([color, label], index) => {
      const item = document.createElement('label');
      item.className = 'legend-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `component-${index}`;
      checkbox.checked = scene.actors[index].getVisibility();
      checkbox.addEventListener('change', () =>
        setComponentVisibility(index, checkbox.checked)
      );
      const swatch = document.createElement('i');
      swatch.style.background = color;
      item.append(checkbox, swatch, document.createTextNode(label));
      return item;
    })
  );
  document.querySelector('#credit').textContent =
    scene.credit || 'Procedural geometry created for this demo using VTK.js.';
  const attributionNote = document.querySelector('#attribution-note');
  attributionNote.textContent = scene.attributionNote || '';
  attributionNote.hidden = !scene.attributionNote;
  const mirrorCredit = document.querySelector('#mirror-credit');
  mirrorCredit.textContent = scene.mirrorCredit
    ? `Recovered data mirror: ${scene.mirrorCredit}`
    : '';
  mirrorCredit.hidden = !scene.mirrorCredit;
  [
    ['#source', scene.sourceUrl, 'Dataset source ↗'],
    ['#license', scene.licenseUrl, scene.licenseLabel || scene.license],
  ].forEach(([selector, href, label]) => {
    const link = document.querySelector(selector);
    const url = href && new URL(href, location.href);
    link.hidden = !url || !['http:', 'https:'].includes(url.protocol);
    link.textContent = label || '';
    if (link.hidden) link.removeAttribute('href');
    else link.href = url.href;
  });
  if (scene.dataset) {
    datasetMessage.textContent = `${scene.name} · ${new Intl.NumberFormat().format(scene.triangles)} triangles`;
  } else {
    datasetMessage.textContent = `${scene.name} · Procedural geometry`;
  }
  retryButton.hidden = true;
  applyOpacity(scene.defaultOpacity);
  return resetCamera();
};

const setScene = (key) => {
  const request = {};
  selectionRequest = request;
  request.completion = (async () => {
    const choice = datasetChoices.find((item) => item.key === key);
    const isDataset = !!choice;
    if (!isDataset && !scenes[key]) throw new Error(`Unknown scene: ${key}`);
    retryButton.hidden = true;
    failedDataset = null;
    if (choice) {
      sceneSelect.value = key;
      datasetMessage.textContent = `Opening ${choice.name}`;
      status.textContent = `Opening ${choice.name}`;
    }
    try {
      const scene = isDataset
        ? await datasets.load(key, (message) => {
            if (selectionRequest === request) {
              datasetMessage.textContent = message;
              status.textContent = message;
            }
          })
        : scenes[key];
      if (selectionRequest !== request) return;
      await activateScene(key, scene);
      if (selectionRequest === request)
        status.textContent = 'WebGPU ready · Linked cameras';
    } catch (error) {
      if (selectionRequest === request) {
        failedDataset = key;
        sceneSelect.value = sceneKey;
        datasetMessage.textContent = `Could not open ${datasetChoices.find((choice) => choice.key === key)?.name || key}. Prepare its local data, then retry. ${error.message}`;
        retryButton.hidden = false;
        status.textContent = 'WebGPU ready · Dataset unavailable';
      }
      throw error;
    }
  })();
  return request.completion;
};

const reverseOrder = () => {
  reversed = !reversed;
  installActors();
  document.querySelector('#reverse').textContent = reversed
    ? 'Restore draw order'
    : 'Reverse draw order';
  return render();
};

const swapDepths = () => {
  depthsSwapped = !depthsSwapped;
  scenes.layers.actors[0].setPosition(0, 0, depthsSwapped ? -0.4 : 0);
  scenes.layers.actors[1].setPosition(0, 0, depthsSwapped ? 0.4 : 0);
  swapButton.textContent = depthsSwapped ? 'Red in front' : 'Swap depths';
  return render();
};

const resize = () => {
  const bounds = container.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  view.setSize(
    Math.max(2, Math.round((bounds.width * ratio) / 2) * 2),
    Math.max(1, Math.round(bounds.height * ratio))
  );
  return render();
};

sceneSelect.addEventListener('change', () => {
  if (sceneSelect.value) setScene(sceneSelect.value).catch(() => {});
});
retryButton.addEventListener('click', () => {
  if (failedDataset) setScene(failedDataset).catch(() => {});
});
opacityControl.addEventListener('input', () =>
  setOpacity(opacityControl.value)
);
document.querySelector('#reverse').addEventListener('click', reverseOrder);
swapButton.addEventListener('click', swapDepths);
document.querySelector('#reset').addEventListener('click', resetCamera);
new ResizeObserver(resize).observe(container);

const ready = (async () => {
  activateScene('nested', scenes.nested);
  resize();
  if (!navigator.gpu) {
    throw new Error(
      'Open this local demo in a browser with WebGPU enabled. Use localhost or HTTPS so the GPU API is available.'
    );
  }
  await view.create3DContextAsync();
  if (!view.getDevice()) {
    throw new Error(
      'The browser could not acquire a WebGPU device. Check hardware acceleration and your browser GPU settings.'
    );
  }
  view.setInitialized(true);
  initialized = true;
  status.textContent = 'WebGPU ready · Linked cameras';
  const requested =
    new URLSearchParams(window.location.search).get('scene') || 'bonsai';
  if (selectionRequest) {
    await selectionRequest.completion.catch(() => render());
    await render();
  } else {
    await setScene(requested).catch(() => render());
  }
})();
ready.catch((error) => showError(error.message));

globalThis.demo = {
  renderWindow,
  view,
  renderers,
  camera,
  controls,
  scenes,
  ready,
  render,
  setScene,
  setOpacity,
  setComponentVisibility,
  reverseOrder,
  swapDepths,
  resetCamera,
};

if (embedded) {
  let reportedHeight = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height !== reportedHeight) {
      reportedHeight = height;
      parent.postMessage(
        { type: 'deep-transparency-size', height },
        location.origin
      );
    }
  }).observe(document.body);
}
