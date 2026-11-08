import vtkWebGPUBufferManager from '@kitware/vtk.js/Rendering/WebGPU/BufferManager';
import '@kitware/vtk.js/Rendering/WebGPU/Profiles/Geometry';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkLight from '@kitware/vtk.js/Rendering/Core/Light';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkWebGPURenderWindow from '@kitware/vtk.js/Rendering/WebGPU/RenderWindow';
import vtkWebGPUForwardPass from '@kitware/vtk.js/Rendering/WebGPU/ForwardPass';
import {
  installDiagnosticBuffers,
  installDiagnosticShaders,
} from './shader-variants.mjs';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';

async function readJSON(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not read ${url}: ${response.status}`);
  return response.json();
}

const errors = [];
const state = { errors };
globalThis.comparison = state;
state.ready = (async () => {
  const spec = await readJSON(new URLSearchParams(location.search).get('spec'));
  state.spec = spec;
  const renderWindow = vtkRenderWindow.newInstance();
  const renderer = vtkRenderer.newInstance({
    useDeepFramebufferTransparency: false,
    automaticLightCreation: false,
  });
  renderWindow.addRenderer(renderer);
  renderer.setBackground(...spec.background, spec.backgroundAlpha ?? 1);
  const camera = renderer.getActiveCamera();
  camera.setPosition(...spec.camera.position);
  camera.setFocalPoint(...spec.camera.focalPoint);
  camera.setViewUp(...spec.camera.viewUp);
  camera.setParallelProjection(spec.camera.parallelProjection);
  camera.setViewAngle(spec.camera.viewAngle);
  camera.setParallelScale(spec.camera.parallelScale);
  camera.setClippingRange(...spec.camera.clippingRange);
  if (spec.camera.windowCenter)
    camera.setWindowCenter(...spec.camera.windowCenter);
  const actors = await Promise.all(
    spec.actors.map(async (layer) => {
      const response = await fetch(layer.url);
      if (!response.ok)
        throw new Error(`Could not read ${layer.url}: ${response.status}`);
      const reader = vtkXMLPolyDataReader.newInstance();
      reader.parseAsArrayBuffer(await response.arrayBuffer());
      const mapper = vtkMapper.newInstance({ scalarVisibility: false });
      mapper.setInputData(reader.getOutputData());
      const actor = vtkActor.newInstance();
      actor.setMapper(mapper);
      const property = actor.getProperty();
      property.set(spec.material);
      property.setColor(...layer.color);
      property.setOpacity(layer.opacity);
      property.setAlphaMode(0);
      property.setLighting(spec.mode === 'pbr');
      if (spec.mode === 'pbr') property.setInterpolationToPBR();
      else property.setInterpolationToPhong();
      reader.delete();
      return actor;
    })
  );
  actors.forEach(renderer.addActor);
  for (const definition of spec.lights) {
    renderer.addLight(
      vtkLight.newInstance({ ...definition, lightType: 'SceneLight' })
    );
  }
  const variant =
    new URLSearchParams(location.search).get('variant') || 'baseline';
  const bufferDiagnostics = installDiagnosticBuffers(
    variant,
    vtkWebGPUBufferManager
  );
  const view = vtkWebGPURenderWindow.newInstance({
    multiSample: spec.multiSample ?? 1,
  });
  view.setContainer(document.body);
  view.setSize(spec.width, spec.height);
  renderWindow.addView(view);
  view.setRenderPasses([vtkWebGPUForwardPass.newInstance()]);
  await view.create3DContextAsync();
  if (!view.getDevice()) throw new Error('WebGPU device unavailable');
  view.setInitialized(true);
  const shaders = installDiagnosticShaders(view.getDevice(), variant);
  const device = view.getDevice().getHandle();
  device.addEventListener('uncapturederror', (event) =>
    errors.push(event.error.message)
  );
  device.pushErrorScope('validation');
  renderWindow.render();
  await device.queue.onSubmittedWorkDone();
  const validation = await device.popErrorScope();
  if (validation) throw new Error(validation.message);
  const adapter = view.getWebGPUConfiguration().getAdapter();
  const adapterInfo =
    adapter.info || (await adapter.requestAdapterInfo?.()) || {};
  state.metadata = {
    implementation: 'vtk.js WebGPU opaque',
    variant,
    deepFramebufferEnabled: renderer.getUseDeepFramebufferTransparency(),
    shaders,
    bufferDiagnostics,
    name: spec.name,
    mode: spec.mode,
    width: spec.width,
    height: spec.height,
    sampleCount: view.getMultiSample(),
    colorAttachmentFormat: view
      .getRenderPasses()[0]
      .getOpaquePass()
      .getColorTexture()
      .getFormat(),
    presentationFormat: view.getPresentationFormat(),
    adapter: {
      vendor: adapterInfo.vendor,
      architecture: adapterInfo.architecture,
      device: adapterInfo.device,
      description: adapterInfo.description,
    },
    limits: {
      maxBufferSize: device.limits.maxBufferSize,
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    },
    geometry: actors.map((actor) => ({
      points: actor.getMapper().getInputData().getNumberOfPoints(),
      polygons: actor.getMapper().getInputData().getNumberOfPolys(),
    })),
  };
  state.readPixels = async () => {
    const image = await view.getPixelsAsync();
    let binary = '';
    for (let i = 0; i < image.colorValues.length; i += 16384) {
      binary += String.fromCharCode(
        ...image.colorValues.subarray(i, i + 16384)
      );
    }
    return { width: image.width, height: image.height, rgba: btoa(binary) };
  };
})();
