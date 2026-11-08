# Deep framebuffer transparency

Enable depth-sorted translucent polygonal rendering on a WebGPU render window:

```js
renderer.setUseDeepFramebufferTransparency(true);
```

The setting defaults to `false`. The WebGPU forward pass creates this pass on
demand when the renderer contains translucent geometry. Collection records
fragments in one geometry pass, then a fullscreen resolve sorts and composites
the nearest sixteen fragments at each sample. Fragments behind opaque geometry
are rejected before they enter the lists.

## Native implementation

The algorithm follows VTK C++ at commit
[`efc4afbd7430e8eddf86759c5d70711af89e50f0`](https://github.com/Kitware/VTK/commit/efc4afbd7430e8eddf86759c5d70711af89e50f0):

- [vtkWebGPUDeepFramebuffer](https://github.com/Kitware/VTK/blob/efc4afbd7430e8eddf86759c5d70711af89e50f0/Rendering/WebGPU/vtkWebGPUDeepFramebuffer.cxx)
  allocates per-pixel list heads, a shared node pool, and an atomic allocator.
- [vtkWebGPUPolyDataMapper](https://github.com/Kitware/VTK/blob/efc4afbd7430e8eddf86759c5d70711af89e50f0/Rendering/WebGPU/vtkWebGPUPolyDataMapper.cxx#L4431)
  appends shaded fragments with storage-buffer atomics and packs color to RGBA8.
- [ABufferResolve.wgsl](https://github.com/Kitware/VTK/blob/efc4afbd7430e8eddf86759c5d70711af89e50f0/Rendering/WebGPU/wgsl/ABufferResolve.wgsl)
  retains the nearest sixteen fragments, breaks equal-depth ties by packed color,
  and composites back to front.
- [vtkWebGPURenderer](https://github.com/Kitware/VTK/blob/efc4afbd7430e8eddf86759c5d70711af89e50f0/Rendering/WebGPU/vtkWebGPURenderer.cxx#L1571)
  blends the premultiplied resolve over opaque color.

This port adapts the representation to vtk.js:

| Native VTK | vtk.js |
| --- | --- |
| 28-byte nodes containing color, depth, four selection identifiers, and next | 12-byte nodes containing color, depth, and next; hardware selection uses its existing separate pass |
| `0xFFFFFFFF` empty head | Zero empty head; nonempty links store the node index plus one |
| Smaller depth is nearer | Larger depth is nearer, following WebGPU reversed depth in vtk.js |
| Single-sample reference implementation | Separate lists and opaque-depth comparisons for every covered sample, including four-sample rendering |

Both implementations use RGBA8 fragment packing, nearest-sixteen retention, a
4096-node traversal bound, packed-color tie-breaking, and premultiplied alpha
composition. RGBA8 packing quantizes opacity as well as RGB; for example, an
opacity of `0.5` is stored as `128 / 255`.

The explicit opaque-depth comparison is required because fragment storage writes
can occur before a hardware depth test rejects the fragment. Four-sample resolve
loads the preserved opaque samples, composites each sample separately, and then
resolves to the single-sample color texture used by later passes.

## Memory and limits

`averageFragmentsPerPixel` defaults to `8` and sets the requested node budget per
sample. It must be finite and positive. With width `W`, height `H`, sample count
`S`, and budget `L`, the requested list storage is approximately
`W * H * S * (4 + 12 * L)` bytes, plus a 16-byte allocator state. Render
attachments consume additional memory.

The node pool is capped by both `maxStorageBufferBindingSize` and `maxBufferSize`.
An unsupported head-buffer size raises a `RangeError`. Changing dimensions,
sample count, or the requested budget reallocates the lists.

The nearest sixteen fragments are selected from the collected list, regardless
of actor insertion order. Fragments beyond the shared pool capacity are omitted;
which fragments survive pool exhaustion can depend on submission order. Lists
longer than 4096 nodes are truncated during traversal. These bounds make deeply
layered scenes approximate.

Volumes retain their existing rendering pass. This pass does not interleave
volume samples with translucent polygonal fragments.

## Image comparison scope

The checked-in image references are rendered by native C++ VTK 9.7.2 through its
Python bindings, using OpenGL dual depth peeling, 64 peels, zero occlusion ratio,
and no multisampling. Their generator, scene specification, backend identity,
and checksums are included in `test/`.

Four complete 256 by 256 images compare exactly: red in front, blue in front,
intersecting planes, and translucent planes with an opaque occluder. These
establish pixel equality for those unlit polygonal compositing scenes. Two
additional curved-mesh scenes check all pixels with a one-channel-level
precision allowance. Only pixels on native color boundaries may instead match
a native color within one neighboring pixel; alpha remains exact everywhere.
The test README and comparison script record the raw differences separately
from these explicit coverage and precision allowances. These checks do
not establish equality to a native WebGPU capture, general lit scenes, or
multisampled native rendering. General colors and opacities can differ from
depth peeling because the deep framebuffer packs each fragment before resolve.

## Direct native WebGPU comparison

The [local comparison utility](../../../../Utilities/DeepFramebufferComparison/README.md)
uses a separately built C++ VTK WebGPU executable with the blog's full mesh
datasets. Shared specifications pin the mesh checksums, camera, materials,
lights, image dimensions, and sample count. It captures true native RGBA and
compares every channel without the boundary or precision allowances used by
the curved depth-peeling fixtures above. Unlit and PBR cases are separate.
Its report records all differences and rejects rendering errors and native
fragment-pool exhaustion. Passing the existing fixtures alone does not imply
that these larger native WebGPU comparisons are pixel-perfect.
