# Local native WebGPU comparison

This utility renders the Bonsai, Engine, Boston Teapot, and LANL impact meshes
with both native C++ VTK WebGPU and vtk.js WebGPU. It compares every RGBA channel
with zero tolerance. A differing pixel fails the comparison; no silhouette mask,
spatial allowance, or color tolerance is applied.

Both renderers read the same VTP files. Shared JSON specifications persist mesh
checksums, camera position and clipping, image dimensions, colors, opacities,
material settings, and lights. The impact input is the preserved yA31 cycle
21255 at 11.00054 seconds on both sides, rather than the article's unavailable
cycle 22198 at 12.00047 seconds.

Unlit cases isolate polygonal transparency. They use ambient 1, diffuse 0,
specular 0, and disabled lighting. PBR cases use the same explicit public
material parameters in both renderers, including a base index of refraction of
1.5. Equal parameters do not imply equal lighting equations, so lit comparisons
are reported separately.

## Native reference

The reference build uses the unmodified VTK revision
`efc4afbd7430e8eddf86759c5d70711af89e50f0` with RenderingWebGPU, IOXML, IOImage,
and jsoncpp enabled. Its official Dawn runtime uses Vulkan with the same
SwiftShader library supplied with the browser installation. The generated
`Data/deep-transparency/native-reference/build-info.json` records source and
runtime URLs, checksums, configure and build commands, and adapter identity.
It is required by the native capture runner.

Build the capture executable against that VTK build. Set
`DEEP_FRAMEBUFFER_WEBGPU_LIBRARY` to the same Dawn shared library that VTK loads
through `VTK_WEBGPU_LIBRARY`:

```sh
cmake -S Utilities/DeepFramebufferComparison \
  -B Data/deep-transparency/native-reference/capture-build \
  -DVTK_DIR=/path/to/vtk-build/lib/cmake/vtk-9.7 \
  -DDEEP_FRAMEBUFFER_WEBGPU_LIBRARY=/path/to/libwebgpu_dawn.so \
  -DDEEP_FRAMEBUFFER_REFERENCE_REVISION=efc4afbd7430e8eddf86759c5d70711af89e50f0
cmake --build Data/deep-transparency/native-reference/capture-build
```

The executable explicitly checks for a WebGPU mapper and enabled deep
framebuffer. It captures native RGBA and records attachment formats, adapter
capabilities, fragment requests, pool capacity, and list lengths. Captures with
rendering errors or an exhausted shared pool are rejected. Native initialization
uses the final image dimensions so that the camera's cached viewport agrees
with fragment-list indexing.

Before a fresh capture, create
`Data/deep-transparency/native-reference/build-info.json`. The committed
`comparison/provenance/build-info.json` documents the original build and can
serve as a template. Set `vtk.sourceDirectory`, `vtk.buildDirectory`,
`dawn.library`, `adapterProbe.icd`, and both `runtimeEnvironment` values to the
actual paths of the build being captured. Record its compiler, configure/build
commands, and SHA-256 values for the source archive, Dawn library, Vulkan ICD,
SwiftShader library, VTK RenderingWebGPU library, and CMake cache. Remove any
original measured fields that were not rechecked. Do not use the historical
runtime paths to describe a different build. The runner reads this new file
and copies its provenance into each capture's metadata; its `--build-info`
option also accepts another explicit path.

## Run

Prepare the original meshes using the example's preparation scripts, then use
a Python environment with VTK, NumPy, and Pillow:

```sh
python Utilities/DeepFramebufferComparison/prepare-specs.py
python Utilities/DeepFramebufferComparison/capture-native.py
```

Start the example server and capture the browser side:

```sh
npm run example -- DeepFramebufferTransparency --no-browser --host 127.0.0.1 --port 9999
node Utilities/DeepFramebufferComparison/capture-browser.mjs
python Utilities/DeepFramebufferComparison/compare.py
```

The last command returns a nonzero exit status for any mismatch. `--report-only`
retains all mismatch measurements while returning success for diagnostic use.
`--cases bonsai-unlit,engine-unlit` selects specific cases. The browser runner
accepts the equivalent `COMPARISON_CASES` environment variable and `DEMO_URL`.

Outputs are kept in the ignored directory
`Utilities/TestResults/deep-transparency/native-webgpu/`: native and browser
images, raw browser RGBA, capture metadata, unaltered difference bytes, RGB and
alpha difference images, an amplified comparison sheet, and `comparison.json`.

Native VTK currently uses an RGBA8 offscreen attachment while vtk.js composites
through RGBA16F. The shader lighting equations also differ. These are recorded
comparison conditions, not exceptions to the zero-tolerance criterion.

## Committed comparison evidence

The standalone repository includes the measured native and browser captures in
`comparison/`, shared specifications in `comparison/specs/`, and native build
provenance in `comparison/provenance/build-info.json`. Verify those original
captures without rebuilding VTK:

```sh
python Utilities/DeepFramebufferComparison/compare.py --captures comparison --specs comparison/specs
```

The expected exit status is 1: all eight recorded cases fail literal pixel
equality. See `comparison/REPORT.md` for counts and limitations. Regenerate
specifications with `prepare-specs.py` before making fresh captures from a
different checkout. The committed specifications and capture metadata preserve
the original run, including its historical absolute paths.
