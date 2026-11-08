export const variants = {
  baseline: [],
  output: ['output'],
  diffuse: ['diffuse'],
  light: ['light'],
  'output-light': ['output', 'light'],
  'output-light-diffuse': ['output', 'light', 'diffuse'],
  'output-light-diffuse-ambient': ['output', 'light', 'diffuse', 'ambient'],
  'output-light-diffuse-ambient-visibility': [
    'output',
    'light',
    'diffuse',
    'ambient',
    'visibility',
  ],
  'output-light-diffuse-ambient-visibility-fresnel': [
    'output',
    'light',
    'diffuse',
    'ambient',
    'visibility',
    'fresnel',
  ],
  ambient: ['ambient'],
  visibility: ['visibility'],
  fresnel: ['fresnel'],
  'output-diffuse': ['output', 'diffuse'],
  'output-diffuse-ambient': ['output', 'diffuse', 'ambient'],
  'output-diffuse-ambient-visibility': [
    'output',
    'diffuse',
    'ambient',
    'visibility',
  ],
  'cpp-equations': [
    'light',
    'output',
    'diffuse',
    'ambient',
    'visibility',
    'fresnel',
    'numeric',
  ],
  'cpp-equations-view': [
    'light',
    'output',
    'diffuse',
    'ambient',
    'visibility',
    'fresnel',
    'numeric',
    'view',
  ],
};

variants['cpp-equations-float-normals'] = [
  ...variants['cpp-equations'],
  'float-normals',
];
variants['cpp-equations-view-float-normals'] = [
  ...variants['cpp-equations-view'],
  'float-normals',
];

export function installDiagnosticBuffers(variant, bufferManagerFactory) {
  const diagnostics = { normalOverrides: 0, normalFormat: 'snorm8x4' };
  if (!variants[variant]?.includes('float-normals')) return diagnostics;
  diagnostics.normalFormat = 'float32x4';
  const original = bufferManagerFactory.newInstance;
  bufferManagerFactory.newInstance = (...args) => {
    const manager = original(...args);
    return {
      ...manager,
      getBuffer(request) {
        if (
          request.format === 'snorm8x4' &&
          request.dataArray?.getName() === 'Normals'
        ) {
          diagnostics.normalOverrides++;
          return manager.getBuffer({
            ...request,
            format: 'float32x4',
            scale: 1,
            hash: `${request.hash}-float-normals`,
          });
        }
        return manager.getBuffer(request);
      },
    };
  };
  return diagnostics;
}

// These substitutions are experiments applied to captured WGSL in this harness.
// Rendering sources and the reference VTK build remain untouched.
export function installDiagnosticShaders(device, variant) {
  const terms = variants[variant];
  if (!terms) throw new Error(`Unknown diagnostic variant ${variant}`);
  const shaders = [];
  const handle = device.getHandle();
  const original = handle.createShaderModule.bind(handle);
  handle.createShaderModule = (description) => {
    let code = description.code;
    if (!code.includes('let baseColor =')) {
      return original(description);
    }
    const replace = (before, after) => {
      if (code.split(before).length !== 2)
        throw new Error(`Expected one shader match: ${before}`);
      code = code.replace(before, after);
    };
    if (terms.includes('light'))
      replace(
        'let H = normalize(L + V);',
        'radiance *= 0.2;\n      let H = normalize(L + V);'
      );
    if (terms.includes('diffuse'))
      replace(
        'let baseColor = _diffuseMap.rgb * diffuseColor.rgb;',
        'let baseColor = diffuseIntensity * _diffuseMap.rgb * diffuseColor.rgb;'
      );
    if (terms.includes('ambient'))
      replace(
        'var PBR = ambientIntensity * ambientColor.rgb * baseColor + color;',
        'var PBR = color;'
      );
    if (terms.includes('visibility'))
      replace(
        'BRDF_specularGGX(alphaRoughness, NdL, NdV, NdH);',
        'V_GGX(NdL, NdV, roughness) * D_GGX(NdH, alphaRoughness);'
      );
    if (terms.includes('fresnel'))
      replace(
        'var l_color = mix(l_dielectric_brdf, l_metal_brdf, metallic);',
        `let cppF0 = mix(f0_dielectric, baseColor, metallic);
      let cppF90 = mix(vec3<f32>(clamp(dot(cppF0, vec3<f32>(16.5)), 0.0, 1.0)), vec3<f32>(1.0), metallic);
      let cppF = fresnelSchlickVec3(cppF0, cppF90, HdL);
      var l_color = (1.0 - metallic) * (vec3<f32>(1.0) - cppF) * l_diffuse + cppF * l_specular;`
      );
    if (terms.includes('numeric')) {
      replace(
        'let NdL = max(dot(normal, L), 0.0);',
        'let NdL = clamp(dot(normal, L), 0.00001, 1.0);'
      );
      replace(
        'let NdH = max(dot(normal, H), 0.0);',
        'let NdH = clamp(dot(normal, H), 0.00001, 1.0);'
      );
      replace(
        'let HdL = max(dot(H, L), 0.0);',
        'let HdL = clamp(dot(H, L), 0.00001, 1.0);'
      );
      replace(
        'let f = (NdH * NdH) * (a2 - 1.0) + 1.0;',
        'let f = (NdH * a2 - NdH) * NdH + 1.0;'
      );
      replace(
        'return a2 / max(pi * f * f, epsilon);',
        'return a2 / max(pi * f * f, 0.00000001);'
      );
    }
    if (terms.includes('view'))
      replace(
        'let V = mix(normalize(-fragPos), vec3<f32>(0, 0, 1), f32(rendererUBO.cameraParallel));',
        'let V = normalize(-fragPos);'
      );
    if (terms.includes('output'))
      replace(
        'computedColor = vec4<f32>(PBR + emission, opacity);',
        'computedColor = vec4<f32>(pow(max(PBR + emission, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2)), opacity);'
      );
    shaders.push({ type: 'fragment', code, terms });
    return original({ ...description, code });
  };
  return shaders;
}
