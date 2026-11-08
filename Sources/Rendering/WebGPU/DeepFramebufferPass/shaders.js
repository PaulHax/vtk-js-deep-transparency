// SPDX-FileCopyrightText: Copyright (c) Ken Martin, Will Schroeder, Bill Lorensen
// SPDX-License-Identifier: BSD-3-Clause

// The resolve follows VTK Rendering/WebGPU/wgsl/ABufferResolve.wgsl, with
// reversed depth, per-sample lists, and zero as the empty-list sentinel.
export const nodeDeclaration = `
struct DeepFragment {
  color: u32,
  depth: f32,
  next: u32,
};
`;

export const stateDeclaration = `
struct DeepState {
  count: atomic<u32>,
  width: u32,
  samples: u32,
  padding: u32,
};
`;

export const collect = (depth) => `
  output.outColor = vec4<f32>(0.0);
  let coord = vec2<i32>(input.fragPos.xy);
  let fragmentDepth = ${depth};
  // Storage writes must pass the depth test explicitly, including when a
  // mapper writes frag_depth and hardware depth testing happens late.
  if (computedColor.a > 0.0 &&
      fragmentDepth >= textureLoad(deepOpaqueDepth, coord, i32(input.sampleIndex))) {
    let pixel = (u32(coord.x) + u32(coord.y) * deepState.width)
      * deepState.samples + input.sampleIndex;
    let index = atomicAdd(&deepState.count, 1u);
    if (index < arrayLength(&deepNodes)) {
      let previous = atomicExchange(&deepHeads[pixel], index + 1u);
      deepNodes[index].color = pack4x8unorm(computedColor);
      deepNodes[index].depth = fragmentDepth;
      deepNodes[index].next = previous;
    }
  }
`;

export const resolve = `
//VTK::Mapper::Dec
//VTK::TCoord::Dec
//VTK::RenderEncoder::Dec
//VTK::IOStructs::Dec

@fragment
fn main(
//VTK::IOStructs::Input
)
//VTK::IOStructs::Output
{
  var output: fragmentOutput;
  let coord = vec2<u32>(input.fragPos.xy);
  let pixel = (coord.x + coord.y * deepState.width)
    * deepState.samples + input.sampleIndex;
  var depths: array<f32, 16>;
  var colors: array<u32, 16>;
  var count = 0u;
  var node = atomicLoad(&deepHeads[pixel]);
  var steps = 0u;
  loop {
    if (node == 0u || node > arrayLength(&deepNodes) || steps >= 4096u) {
      break;
    }
    steps += 1u;
    let fragment = deepNodes[node - 1u];
    node = fragment.next;
    var position = min(count, 15u);
    if (count == 16u && (fragment.depth < depths[15] ||
        (fragment.depth == depths[15] && fragment.color >= colors[15]))) {
      continue;
    }
    loop {
      if (position == 0u) { break; }
      let prior = position - 1u;
      if (depths[prior] > fragment.depth ||
          (depths[prior] == fragment.depth && colors[prior] <= fragment.color)) {
        break;
      }
      depths[position] = depths[prior];
      colors[position] = colors[prior];
      position = prior;
    }
    depths[position] = fragment.depth;
    colors[position] = fragment.color;
    count = min(count + 1u, 16u);
  }
  if (count == 0u) { discard; }
  var computedColor = vec4<f32>(0.0);
  loop {
    if (count == 0u) { break; }
    count -= 1u;
    let source = unpack4x8unorm(colors[count]);
    computedColor = vec4<f32>(source.rgb * source.a, source.a)
      + computedColor * (1.0 - source.a);
  }
  //VTK::RenderEncoder::Impl
  return output;
}
`;
