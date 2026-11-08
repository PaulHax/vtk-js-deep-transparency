The PNG references are rendered independently by native VTK 9.7.2 using its C++ OpenGL dual depth peeling implementation through Python bindings. The generator refuses to save a reference unless `GetLastRenderingUsedDepthPeeling()` confirms that depth peeling ran. `baselines/manifest.json` records the backend, scene and mesh hashes, image hashes, and inspected deep framebuffer source revision.

To regenerate the references in a Python environment containing `vtk` and `Pillow`:

```sh
python Sources/Rendering/WebGPU/DeepFramebufferPass/test/generate-native-baselines.py
```

Run the browser checks with a WebGPU-capable Chromium installation:

```sh
CI=1 WEBGPU=1 NO_WEBGL=1 npx vitest run Sources/Rendering/WebGPU/DeepFramebufferPass/test/testDeepFramebufferPass.js --retry=0
```

Four planar screenshot checks compare every RGBA channel exactly against the native references. They cover both depth orders, intersecting surfaces whose relative depth varies across pixels, and opaque occlusion. `scenes.json` shares geometry, camera, lighting, material, image size, and sample count. Two additional 3D scenes use identical float32 triangle meshes from `meshes.json` for nested and intersecting spheres.

The 3D comparisons have an explicit rasterization margin: every pixel outside a native reference color boundary must agree within one channel level. A boundary is identified solely from color transitions in the native pixel's immediate eight neighbors. At a boundary, the browser pixel must match one of those native neighboring colors within one channel level; alpha must match exactly everywhere. At least 90% of each image must be checked without a spatial margin. This permits a one-pixel coverage difference while continuing to reject incorrect interior compositing.

Measured at 256 by 256 on the software reference environment, all four planar images have zero differing channels. The nested sphere scene differs at 22 boundary pixels, with exact stable interiors. The intersecting sphere scene differs at 1,703 pixels; 38 pixels differ by more than one channel level and all fall on a native color boundary. Its maximum stable interior error is one channel level. These are measured results, not allowed mismatch counts.

Additional renders check insertion-order independence, nearest-sixteen retention, frame clearing, opacity changes, resize, viewport bounds, and changing canvas content while switching between one and four samples. Each capture fails on a WebGPU validation error.

To build a contact sheet and JSON metrics from saved 256 by 256 canvas screenshots named `<scene>-webgpu.png`:

```sh
python Sources/Rendering/WebGPU/DeepFramebufferPass/test/compare-native-baselines.py --captures Utilities/TestResults/deep-transparency
```

These fixtures establish agreement for the tested scenes. They do not establish pixel equality for arbitrary scenes or native WebGPU rendering: these particular fixtures use the OpenGL depth-peeling backend. Deep framebuffer fragments are packed to RGBA8 before composition, while depth peeling can retain greater intermediate precision. Colors, opacities, lighting, and edge rasterization outside these fixtures can differ across rendering backends.

The separate [native WebGPU comparison utility](../../../../../Utilities/DeepFramebufferComparison/README.md) builds and invokes a local C++ reference for the full blog datasets. It shares explicit scene specifications between the C++ and browser renderers and uses zero-tolerance RGBA comparisons. Its captures are independent of the OpenGL references in this directory, and its strict comparison can fail even when all fixtures here pass.
