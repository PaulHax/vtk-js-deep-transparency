# Opaque PBR comparison

This harness compares vtk.js WebGPU with C++ VTK WebGPU using opaque surfaces,
one directional light, and shared mesh and scene specifications. It isolates
lighting differences without enabling deep transparency. Diagnostic variants
change shaders and normal-buffer formats only inside the fixture page; they
do not change the rendering implementation.

The [report](REPORT.md) describes the measured causes and unresolved questions.
The committed [measurements](evidence/summary.json),
[comparison image](evidence/comparison.png), and
[evidence manifest](evidence/manifest.json) support its results. The final
diagnostic configuration has eight exact images and fourteen with maximum
channel error one across twenty-two scenes. It is not a production PBR fix.

## Reproduce

Use the Node version recorded in [`.nvmrc`](../../.nvmrc). Install the package
dependencies and test browser, and generate the deterministic fixtures:

```sh
npm ci
npx playwright install chromium
python3 Utilities/PBRComparison/prepare-specs.py
```

Python analysis requires NumPy and Pillow. Mesh generation uses only the
Python standard library.

Build the pinned C++ VTK revision
[`efc4afbd7430e8eddf86759c5d70711af89e50f0`](https://github.com/Kitware/VTK/tree/efc4afbd7430e8eddf86759c5d70711af89e50f0)
with RenderingWebGPU, IOXML, IOImage and jsoncpp. Follow the
[native runtime setup](../DeepFramebufferComparison/README.md#native-reference)
and create a build-info JSON describing the actual build and runtime paths.
The committed [historical build record](../../comparison/provenance/build-info.json)
documents the reference configuration and expected fields; its machine-specific
paths must be replaced for a new build.

Configure the capture executable against that build. Set these paths to the
VTK build, Dawn library and build-info JSON on the machine running the capture:

```sh
VTK_BUILD=/path/to/vtk-build
DAWN_LIBRARY=/path/to/libwebgpu_dawn.so
BUILD_INFO=/path/to/native-reference/build-info.json
cmake -S Utilities/PBRComparison \
  -B Utilities/TestResults/pbr-isolation/native-build \
  -DVTK_DIR="$VTK_BUILD/lib/cmake/vtk-9.7" \
  -DDEEP_FRAMEBUFFER_WEBGPU_LIBRARY="$DAWN_LIBRARY" \
  -DDEEP_FRAMEBUFFER_REFERENCE_REVISION=efc4afbd7430e8eddf86759c5d70711af89e50f0
cmake --build Utilities/TestResults/pbr-isolation/native-build
python3 Utilities/PBRComparison/capture-native.py --build-info "$BUILD_INFO"
```

The Dawn library passed to CMake must match `VTK_WEBGPU_LIBRARY` in the
build-info runtime environment. The recorded runs use Vulkan with different native and browser SwiftShader
builds, identified in the [capture metadata](evidence/capture-metadata.json).
Library checksums are checked before native capture. Pinning one shared driver
build is a further control for a new comparison.

In a separate terminal, start the example server:

```sh
npm run example -- DeepFramebufferTransparency --no-browser --host 127.0.0.1 --port 10001
```

The fixture loads [`browser.html`](browser.html) directly through the example
server's Vite configuration. Capture the browser and analyze both outputs:

```sh
node Utilities/PBRComparison/capture-browser.mjs
python3 Utilities/PBRComparison/analyze.py
```

Full generated captures, specifications, shaders and differences are written to
the ignored `Utilities/TestResults/pbr-isolation/` directory. The committed `evidence/` directory contains lossless PNGs for every recorded
capture, deduplicated shaders, portable scene specifications and capture
metadata. It is a snapshot of this run, not the output directory for a new run.
Recorded metadata retains historical capture-relative paths with machine roots
replaced by placeholders; `scene-specifications.json` points to bundled meshes.

Check the published evidence without starting either renderer:

```sh
python3 Utilities/PBRComparison/verify-evidence.py
```

To package a new completed run after capture and analysis:

```sh
python3 Utilities/PBRComparison/package-evidence.py
```

Native `--cases name1,name2`, browser `COMPARISON_CASES=name1,name2`, and
`PBR_VARIANTS=baseline,cpp-equations` select subsets. Set `DEMO_URL` for a
different server address. Both capture runners accept custom specification and
output locations; see `capture-native.py --help` and the browser runner's
`COMPARISON_SPECS` and `COMPARISON_OUTPUT` variables. Pass matching subsets to
`analyze.py --cases ... --variants ...`.

## Controls and diagnostic variants

[`prepare-specs.py`](prepare-specs.py) defines the fixtures. Each has one opaque,
scalar-free actor with explicit point normals and a shared SHA256-checked VTP,
a black opaque background, one sample per pixel, and one nonpositional
SceneLight. Main fixtures use perspective projection. Ambient controls retain
a black light so C++ stays on its lit PBR path. One orthographic sphere tests
the view-vector convention.

[`shader-variants.mjs`](shader-variants.mjs) wraps
`GPUDevice.createShaderModule` in this fixture page. Exact-match assertions
reject substitutions if expected shader text changes. Baseline shader text is
captured without substitution. Float-normal variants also wrap the fixture's
buffer-manager factory to upload supplied normals as float32 rather than packed
snorm8; metadata verifies that this override was exercised.

| Variant                            | Change                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `output`                           | C++ output power `1/2.2`.                                               |
| `light`                            | Divide radiance by five to undo the vtk.js upload multiplier.           |
| `diffuse`                          | Multiply base color by the public diffuse coefficient.                  |
| `ambient`                          | Remove ambient for C++ lit/no-IBL parity.                               |
| `visibility`                       | Use roughness squared in correlated GGX visibility.                     |
| `fresnel`                          | Mix F0/F90 before attenuating diffuse, as C++ does.                     |
| `output-light-*`                   | Apply the named terms cumulatively.                                     |
| `cpp-equations`                    | Combine these terms with C++ angle clamps and distribution arithmetic.  |
| `cpp-equations-view`               | Also use C++'s position-derived view vector in orthographic projection. |
| `cpp-equations-float-normals`      | Combine equations with supplied float32 normals.                        |
| `cpp-equations-view-float-normals` | Combine equations, view convention and float32 normals.                 |

[`analyze.py`](analyze.py) retains strict whole-image RGBA metrics with zero
tolerance. Interior and center measurements are separately labeled diagnostics;
they never waive a whole-image mismatch. The analyzer saves measurements even
when images differ, so successful execution does not mean pixel equality.

These variants establish experimental parity with a pinned implementation.
They do not decide which physical model or API conventions should be adopted.
