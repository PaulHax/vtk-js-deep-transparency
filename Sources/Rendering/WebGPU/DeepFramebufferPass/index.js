import macro from 'vtk.js/Sources/macros';
import vtkRenderPass from 'vtk.js/Sources/Rendering/SceneGraph/RenderPass';
import vtkWebGPUBindGroup from 'vtk.js/Sources/Rendering/WebGPU/BindGroup';
import vtkWebGPUFullScreenQuad from 'vtk.js/Sources/Rendering/WebGPU/FullScreenQuad';
import vtkWebGPURenderEncoder from 'vtk.js/Sources/Rendering/WebGPU/RenderEncoder';
import vtkWebGPUShaderCache from 'vtk.js/Sources/Rendering/WebGPU/ShaderCache';
import vtkWebGPUTexture from 'vtk.js/Sources/Rendering/WebGPU/Texture';
import { collect, resolve, nodeDeclaration, stateDeclaration } from './shaders';

/* eslint-disable no-undef, no-bitwise */

function vtkWebGPUDeepFramebufferPass(publicAPI, model) {
  model.classHierarchy.push('vtkWebGPUDeepFramebufferPass');

  function retireResources() {
    const buffers = model.buffers;
    const scratchTexture = model.scratchTexture;
    if (!buffers && !scratchTexture) {
      return;
    }
    const destroy = () => {
      buffers?.forEach((buffer) => buffer.destroy());
      scratchTexture?.destroy();
    };
    if (model.pendingSubmission?.value) {
      // A prior renderer in the same command encoder may still use these.
      model.device.afterNextSubmit(destroy);
    } else {
      destroy();
    }
    model.buffers = null;
    model.scratchTexture = null;
  }

  function createResources(viewNode, sampleCount) {
    if (
      !Number.isFinite(model.averageFragmentsPerPixel) ||
      model.averageFragmentsPerPixel <= 0
    ) {
      throw new RangeError(
        'Deep framebuffer requires a positive finite fragment budget'
      );
    }
    const device = viewNode.getDevice();
    const handle = device.getHandle();
    const { width, height } = viewNode.getCanvas();
    const slots = width * height * sampleCount;
    const limit = Math.min(
      handle.limits.maxStorageBufferBindingSize,
      handle.limits.maxBufferSize
    );
    if (slots * 4 > limit) {
      throw new RangeError(
        'Deep framebuffer head buffer exceeds device limits'
      );
    }
    const capacity = Math.min(
      Math.floor(slots * model.averageFragmentsPerPixel),
      Math.floor(limit / 12)
    );
    if (capacity < 1) {
      throw new RangeError(
        'Deep framebuffer requires a positive fragment budget'
      );
    }
    retireResources();
    model.device = device;
    model.pendingSubmission = { value: false };
    model.bindGroupTime.modified();
    model.buffers = [slots * 4, capacity * 12, 16].map((size, index) =>
      handle.createBuffer({
        label: ['deepHeads', 'deepNodes', 'deepState'][index],
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    );
    handle.queue.writeBuffer(
      model.buffers[2],
      0,
      new Uint32Array([0, width, sampleCount, 0])
    );
    const names = ['deepHeads', 'deepNodes', 'deepState'];
    const declarations = ['', nodeDeclaration, stateDeclaration];
    const types = ['array<atomic<u32>>', 'array<DeepFragment>', 'DeepState'];
    const bindables = names.map((name, index) => ({
      getBindGroupTime: () => model.bindGroupTime,
      getBindGroupLayoutEntry: () => ({
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'storage' },
      }),
      getBindGroupEntry: () => ({ resource: { buffer: model.buffers[index] } }),
      getShaderCode: (binding, group) => `${declarations[index]}
        @group(${group}) @binding(${binding})
        var<storage, read_write> ${name}: ${types[index]};`,
    }));
    bindables.push({
      getBindGroupTime: () => model.depthTextureView.getBindGroupTime(),
      getBindGroupLayoutEntry: () => ({
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth', multisampled: sampleCount > 1 },
      }),
      getBindGroupEntry: () => ({
        resource: model.depthTextureView.getHandle(),
      }),
      getShaderCode: (binding, group) => `@group(${group}) @binding(${binding})
        var deepOpaqueDepth: texture_depth_${sampleCount > 1 ? 'multisampled_2d' : '2d'};`,
    });
    model.bindGroup = vtkWebGPUBindGroup.newInstance({
      label: 'deepFramebufferBG',
    });
    model.bindGroup.setBindables(bindables);

    model.scratchTexture = vtkWebGPUTexture.newInstance({
      label: 'deepCollection',
    });
    model.scratchTexture.create(device, {
      width,
      height,
      format: 'rgba16float',
      sampleCount,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    model.collectionEncoder = vtkWebGPURenderEncoder.newInstance({
      label: 'deepFramebufferCollection',
      passBindGroup: model.bindGroup,
    });
    model.collectionEncoder.setPipelineHash(`deepCollect${sampleCount}`);
    model.collectionEncoder.setDescription({
      colorAttachments: [
        {
          view: null,
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: [0, 0, 0, 0],
        },
      ],
      depthStencilAttachment: { view: null, depthReadOnly: true },
    });
    model.collectionEncoder.setColorTextureView(
      0,
      model.scratchTexture.createView()
    );
    model.collectionEncoder.setPipelineSettings({
      primitive: { cullMode: 'none' },
      multisample: { count: sampleCount },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
      fragment: { targets: [{ format: 'rgba16float', writeMask: 0 }] },
    });
    model.collectionEncoder.setReplaceShaderCodeFunction((pipeline) => {
      const desc = pipeline.getShaderDescription('fragment');
      desc.addOutput('vec4<f32>', 'outColor');
      desc.addBuiltinInput('vec4<f32>', '@builtin(position) fragPos');
      desc.addBuiltinInput('u32', '@builtin(sample_index) sampleIndex');
      let code = desc.getCode();
      const depth = /output\.fragDepth\s*=/.test(code)
        ? 'output.fragDepth'
        : 'input.fragPos.z';
      code = vtkWebGPUShaderCache.substitute(
        code,
        '//VTK::RenderEncoder::Dec',
        model.bindGroup.getShaderCode(pipeline)
      ).result;
      code = vtkWebGPUShaderCache.substitute(
        code,
        '//VTK::RenderEncoder::Impl',
        collect(depth)
      ).result;
      desc.setCode(code);
    });

    model.resolveEncoder = vtkWebGPURenderEncoder.newInstance({
      label: 'deepFramebufferResolve',
      passBindGroup: model.bindGroup,
    });
    model.resolveEncoder.setPipelineHash(`deepResolve${sampleCount}`);
    model.resolveEncoder.setDescription({
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
    });
    model.resolveEncoder.setPipelineSettings({
      primitive: { cullMode: 'none' },
      multisample: { count: sampleCount },
      fragment: {
        targets: [
          {
            format: 'rgba16float',
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
    });
    model.resolveEncoder.setReplaceShaderCodeFunction((pipeline) => {
      const desc = pipeline.getShaderDescription('fragment');
      desc.addOutput('vec4<f32>', 'outColor');
      desc.addBuiltinInput('vec4<f32>', '@builtin(position) fragPos');
      desc.addBuiltinInput('u32', '@builtin(sample_index) sampleIndex');
      let code = vtkWebGPUShaderCache.substitute(
        desc.getCode(),
        '//VTK::RenderEncoder::Dec',
        model.bindGroup.getShaderCode(pipeline)
      ).result;
      code = vtkWebGPUShaderCache.substitute(
        code,
        '//VTK::RenderEncoder::Impl',
        'output.outColor = computedColor;'
      ).result;
      desc.setCode(code);
    });
    model.quad = vtkWebGPUFullScreenQuad.newInstance();
    model.quad.setDevice(device);
    model.quad.setPipelineHash(`deepResolveQuad${sampleCount}`);
    model.quad.setFragmentShaderTemplate(resolve);
    model.resourceKey = [
      width,
      height,
      sampleCount,
      model.averageFragmentsPerPixel,
    ].join('/');
  }

  publicAPI.traverse = (renNode, viewNode) => {
    if (model.deleted) {
      return;
    }
    model._currentParent = viewNode;
    const sampleCount = Math.max(1, viewNode.getMultiSample());
    const { width, height } = viewNode.getCanvas();
    const key = [
      width,
      height,
      sampleCount,
      model.averageFragmentsPerPixel,
    ].join('/');
    if (model.resourceKey !== key || model.device !== viewNode.getDevice()) {
      createResources(viewNode, sampleCount);
    }
    const commandEncoder = viewNode.getCommandEncoder();
    if (!model.pendingSubmission.value) {
      const pending = model.pendingSubmission;
      pending.value = true;
      model.device.afterNextSubmit(() => {
        pending.value = false;
      });
    }
    commandEncoder.clearBuffer(model.buffers[0]);
    commandEncoder.clearBuffer(model.buffers[2], 0, 4);
    model.collectionEncoder.setDepthTextureView(model.depthTextureView);
    model.collectionEncoder.attachTextureViews();
    publicAPI.setCurrentOperation('translucentPass');
    renNode.setOpaqueColorTextureView(model.colorTextureView);
    renNode.setRenderEncoder(model.collectionEncoder);
    renNode.traverse(publicAPI);

    model.resolveEncoder.setColorTextureView(
      0,
      sampleCount > 1
        ? model.multisampleColorTextureView
        : model.colorTextureView
    );
    if (sampleCount > 1) {
      model.resolveEncoder.setResolveTextureView(0, model.colorTextureView);
    }
    model.resolveEncoder.attachTextureViews();
    model.resolveEncoder.begin(commandEncoder);
    renNode.scissorAndViewport(model.resolveEncoder);
    model.quad.prepareAndDraw(model.resolveEncoder);
    model.resolveEncoder.end();
  };

  publicAPI.releaseGraphicsResources = () => {
    retireResources();
    model.quad?.releaseGraphicsResources();
    model.bindGroup?.releaseGraphicsResources();
    model.scratchTexture = null;
    model.collectionEncoder = null;
    model.resolveEncoder = null;
    model.quad = null;
    model.bindGroup = null;
    model.resourceKey = null;
    model.device = null;
  };
  publicAPI.delete = macro.chain(
    publicAPI.releaseGraphicsResources,
    publicAPI.delete
  );
}

export function extend(publicAPI, model, initialValues = {}) {
  Object.assign(
    model,
    {
      averageFragmentsPerPixel: 8,
      colorTextureView: null,
      depthTextureView: null,
      multisampleColorTextureView: null,
      buffers: null,
      device: null,
      resourceKey: null,
    },
    initialValues
  );
  vtkRenderPass.extend(publicAPI, model, initialValues);
  model.bindGroupTime = {};
  macro.obj(model.bindGroupTime);
  macro.setGet(publicAPI, model, [
    'colorTextureView',
    'depthTextureView',
    'multisampleColorTextureView',
    'averageFragmentsPerPixel',
  ]);
  vtkWebGPUDeepFramebufferPass(publicAPI, model);
}

export const newInstance = macro.newInstance(
  extend,
  'vtkWebGPUDeepFramebufferPass'
);
export default { newInstance, extend };
