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
const parameters = new URLSearchParams(location.search);
const embedded = parameters.has('embed');
const initialScene = parameters.get('scene') || 'bonsai';
document.body.classList.toggle('embedded', embedded);

document.body.innerHTML = `
  <main class="laboratory">
    <header class="masthead">
      <div class="brand"><strong>VTK.js</strong> Rendering laboratory</div>
      <div class="status" role="status" id="status">Preparing WebGPU</div>
    </header>
    <section class="intro" aria-labelledby="title">
      <div>
        <p class="eyebrow">Order-independent transparency</p>
        <h1 id="title">Transparency, in depth.</h1>
      </div>
      <p class="intro-copy">Look inside overlapping surfaces. The same geometry, camera and materials, with two ways to combine transparent layers.</p>
    </section>
    <p class="article-link"><a href="https://www.kitware.com/better-transparency-with-vtk-and-webgpu/" target="_blank" rel="noreferrer">Read the Kitware article: Better Transparency with VTK and WebGPU ↗</a></p>
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
    <section class="comparison" aria-label="Transparency comparison">
      <div class="view-labels">
        <div class="view-label"><span class="method-dot"></span>Weighted blend<span class="method-type">Depth-weighted average</span></div>
        <div class="view-label deep"><span class="method-dot"></span>Deep framebuffer<span class="method-type">Depth-sorted, up to 16 fragments</span></div>
      </div>
      <div class="viewport" id="viewport" aria-label="Interactive 3D comparison">
        <div class="interaction-hint"><span></span>Left drag rotates · Right drag pans · Click to focus for wheel zoom</div>
        <div class="error" id="error" hidden></div>
      </div>
      <div class="scene-info">
        <div class="component-heading">
          <p id="description"></p>
          <div class="component-actions">
            <button type="button" class="action component-swap" id="swap" hidden disabled>Swap depths</button>
            <button type="button" class="component-action" id="reset" aria-label="Reset camera" title="Reset camera" disabled>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><path d="m10 10-3 3 3 3m-3-3h6a3 3 0 0 1 3 3" /></svg>
            </button>
          </div>
        </div>
        <div class="legend" id="legend"></div>
      </div>
      <div class="dataset-credit" id="dataset-credit" aria-label="Model attribution">
        <div><p id="credit"></p><p id="attribution-note" hidden></p><p id="mirror-credit" hidden></p></div>
        <div class="credit-links"><a id="source" target="_blank" rel="noreferrer" hidden>Dataset source ↗</a><a id="license" target="_blank" rel="noreferrer" hidden></a></div>
      </div>
    </section>
    <footer class="footer"><span>WebGPU · Polygonal surfaces · Up to 16 retained fragments per pixel</span><a href="https://www.kitware.com/better-transparency-with-vtk-and-webgpu/" target="_blank" rel="noreferrer">Inspired by VTK's deep framebuffer ↗</a></footer>
  </main>
`;

const container = document.querySelector('#viewport');
const status = document.querySelector('#status');
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

let sceneKey = null;
let reversed = false;
let depthsSwapped = false;
let initialized = false;
let selectionRequest = null;
let failedDataset = null;

const render = async () => {
  if (!initialized || sceneKey === null) return;
  renderers.forEach((renderer) => renderer.resetCameraClippingRange());
  renderWindow.render();
  await view.getDevice().getHandle().queue.onSubmittedWorkDone();
};

const controls = createArcballControls({ view, renderers, camera, render });

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) {
    controls.delete();
    view.delete();
  }
});

const fitEmbedded = () => {
  if (!embedded || parent === window) return;
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  parent.gallery.resizeFrame(window, height);
};

const reportStatus = (state, message) => {
  if (!embedded || parent === window) return;
  parent.postMessage(
    { type: 'deep-transparency-status', state, message },
    location.origin
  );
};

const showLoading = (message) => {
  status.textContent = message;
  reportStatus('loading', message);
};

const showError = (message) => {
  status.textContent = 'Example unavailable';
  const error = document.querySelector('#error');
  const heading = document.createElement('h2');
  heading.textContent = 'Could not load this example';
  const detail = document.createElement('p');
  detail.textContent = message;
  error.replaceChildren(heading, detail);
  error.hidden = false;
  fitEmbedded();
  reportStatus('error', message);
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

const componentActor = (index) => {
  const actor = scenes[sceneKey]?.actors[index];
  if (!actor) throw new Error(`Unknown component: ${index}`);
  return actor;
};

const eyeIcon = (visible) => `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    ${visible ? '' : '<path d="m3 3 18 18" />'}
  </svg>
`;

const syncComponentVisibility = (index) => {
  const visible = componentActor(index).getVisibility();
  const button = document.querySelector(`#component-${index}`);
  const label = scenes[sceneKey].legend[index][1];
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${label}`);
  button.title = `${visible ? 'Hide' : 'Show'} ${label}`;
  button.innerHTML = eyeIcon(visible);
};

const syncComponentOpacity = (index) => {
  const value = componentActor(index).getProperty().getOpacity();
  const input = document.querySelector(`#component-opacity-${index}`);
  const percentage = `${Math.round(value * 100)}%`;
  input.value = value;
  input.setAttribute('aria-valuetext', percentage);
  document.querySelector(`#component-opacity-value-${index}`).value =
    percentage;
};

const applyComponentOpacity = (index, opacity) => {
  const value = Number(opacity);
  if (!Number.isFinite(value)) throw new TypeError('Opacity must be finite');
  componentActor(index)
    .getProperty()
    .setOpacity(Math.min(1, Math.max(0, value)));
  syncComponentOpacity(index);
};

const setComponentOpacity = (index, opacity) => {
  applyComponentOpacity(index, opacity);
  return render();
};

const setOpacity = (opacity) => {
  scenes[sceneKey].controlledActors.forEach((index) =>
    applyComponentOpacity(index, opacity)
  );
  return render();
};

const setComponentVisibility = (index, visible) => {
  componentActor(index).setVisibility(Boolean(visible));
  syncComponentVisibility(index);
  return render();
};

const createComponentControls = ([color, label], index) => {
  const row = document.createElement('div');
  row.className = 'component-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', label);

  const visibility = document.createElement('button');
  visibility.type = 'button';
  visibility.id = `component-${index}`;
  visibility.className = 'component-visibility';
  visibility.addEventListener('click', () =>
    setComponentVisibility(index, !componentActor(index).getVisibility())
  );

  const name = document.createElement('label');
  name.className = 'component-name';
  name.htmlFor = `component-opacity-${index}`;
  const swatch = document.createElement('i');
  swatch.style.background = color;
  const text = document.createElement('span');
  text.textContent = label;
  name.append(swatch, text);

  const opacity = document.createElement('input');
  opacity.type = 'range';
  opacity.id = `component-opacity-${index}`;
  opacity.className = 'component-opacity';
  opacity.min = '0';
  opacity.max = '1';
  opacity.step = '0.01';
  opacity.setAttribute('aria-label', `${label} opacity`);
  opacity.addEventListener('input', () =>
    setComponentOpacity(index, opacity.value)
  );

  const value = document.createElement('output');
  value.id = `component-opacity-value-${index}`;
  value.htmlFor = opacity.id;
  value.className = 'component-opacity-value';
  row.append(visibility, name, opacity, value);
  return row;
};

const activateScene = (key, scene) => {
  scenes[key] = scene;
  sceneKey = key;
  document.querySelector('#error').hidden = true;
  installActors();
  renderers.forEach((renderer) => renderer.setBackground(...scene.background));
  sceneSelect.value = key;
  swapButton.hidden = key !== 'layers';
  swapButton.disabled = false;
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
  document
    .querySelector('#legend')
    .replaceChildren(...scene.legend.map(createComponentControls));
  scene.actors.forEach((actor, index) => {
    syncComponentVisibility(index);
    syncComponentOpacity(index);
  });
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
  document.querySelector('#reset').disabled = false;
  fitEmbedded();
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
      showLoading(`Opening ${choice.name}`);
    }
    try {
      const scene = isDataset
        ? await datasets.load(key, (message) => {
            if (selectionRequest === request) {
              datasetMessage.textContent = message;
              showLoading(message);
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
        datasetMessage.textContent = `Could not open ${datasetChoices.find((choice) => choice.key === key)?.name || key}. Please retry loading. ${error.message}`;
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
swapButton.addEventListener('click', swapDepths);
document.querySelector('#reset').addEventListener('click', resetCamera);
new ResizeObserver(resize).observe(container);

const ready = (async () => {
  fitEmbedded();
  resize();
  showLoading('Preparing WebGPU');
  if (!navigator.gpu) {
    throw new Error(
      'This browser does not expose WebGPU. Use a browser with WebGPU and hardware acceleration enabled.'
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
  if (selectionRequest) {
    await selectionRequest.completion;
    await render();
  } else {
    await setScene(initialScene);
  }
  fitEmbedded();
  reportStatus('ready', 'Ready');
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
  setComponentOpacity,
  reverseOrder,
  swapDepths,
  resetCamera,
};

if (embedded && parent !== window) {
  new ResizeObserver(fitEmbedded).observe(document.body);
}
