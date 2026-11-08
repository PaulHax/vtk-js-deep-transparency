# Deep framebuffer transparency in vtk.js

[Open the gallery](https://paulhax.github.io/vtk-js-deep-transparency/) · [Read the Kitware article](https://www.kitware.com/better-transparency-with-vtk-and-webgpu/)

A WebGPU port of VTK's deep framebuffer transparency, with a linked comparison demo, full-resolution scientific meshes, and direct native C++ VTK image comparisons.

**The native comparisons are not pixel-perfect.** All eight recorded dataset cases fail a strict zero-tolerance RGBA comparison. The final alpha channels agree for these opaque-background captures, and reversing actor insertion order changes no browser pixels. Unlit images are close; PBR lighting differs substantially. See the [measured results](comparison/REPORT.md), [comparison images](comparison/comparison.png), and [machine-readable metrics](comparison/comparison.json).

## Run the demo

```sh
npm ci
npm run example -- DeepFramebufferTransparency --no-browser --host 127.0.0.1 --port 9999
```

Open [localhost:9999](http://localhost:9999) in a WebGPU browser. Prepared meshes are included; viewing the gallery needs no data-preparation step or download from the original dataset hosts.

The page is a long scrolling gallery with anchor links to eight examples. Two examples initialize at a time; the others begin automatically as loading slots become available. Spinners show each example's loading state. After its first completed frame, each example renders only in response to interaction or resizing and retains its own camera, controls, and attribution caption. Jump directly to [Sinus anatomy](http://localhost:9999/#anatomy) or [Ball-bearing assembly](http://localhost:9999/#cad).

- Left drag: quaternion arcball rotation with a smooth transition at the rim, including free roll.
- Right drag: pan both views.
- Mouse wheel: click a view to focus it, then zoom toward the surface under the pointer. Empty space uses the focal plane. An unfocused view leaves wheel events to page scrolling; Escape releases focus.
- Component controls: each row has an eye button to show or hide that structure and an independent opacity slider from 0% to 100%. Changes apply to both viewports; hiding a structure preserves its opacity.

For every example, the left viewport uses weighted blending; the right retains and sorts fragments. Both share geometry, camera, lights, and materials. The gallery uses one sample per pixel. Its deep resolve sorts up to sixteen collected fragments per pixel, with eight-bit color and opacity packing and a bounded shared pool. Deeply layered scenes can therefore omit fragments. Open separately links provide a standalone viewer for each example.

## Examples

The gallery includes the article's **Bonsai**, **Engine**, and **Boston Teapot** scans, plus genuine **asteroid ocean impact** data recovered from a public research mirror. The recovered frame is yA31 cycle 21255 at 11.00054 seconds; the article shows cycle 22198 at 12.00047 seconds. This difference is labeled in the demo.

**Sinus anatomy** uses real NasalSeg CT case P001 with expert-reviewed masks for both maxillary sinuses, both nasal cavities, and the nasopharynx. The transparent facial bone comes from the same registered cropped CT. Hide bone to inspect the intertwined passages. Frontal, ethmoid, and sphenoid sinuses are outside this example's annotation coverage. The dataset is [CC BY 4.0](https://zenodo.org/records/13893419); the manifest records attribution and source hashes.

**Ball-bearing assembly** is a reproducible parametric mechanical model: two grooved races, twelve balls, and a retainer with spherical pockets. Transparent outer parts expose the fitted internal components. It is a geometric demonstration, not a manufacturer CAD file or an engineering-certified design.

Two small compositing scenes isolate intersecting rings and two-layer alpha composition. They appear at the bottom of the gallery. See the [example documentation](Examples/Rendering/DeepFramebufferTransparency/api.md) for preparation scripts and controls.

The attribution caption names the dataset creators, links to the source and published license when available, and describes modifications such as contouring and smoothing. Open SciVis scan captions retain the original providers and credit curator Pavol Klacansky. The manifests record that the scan source page does not specify a license. The impact scene credits the LANL simulation and the public research mirror. The bearing and two compositing examples identify their models as original procedural geometry. Detailed provenance remains in each dataset manifest.

## Verify the recorded C++ comparison

Install NumPy and Pillow in a Python environment, then run from this checkout:

```sh
python Utilities/DeepFramebufferComparison/compare.py --captures comparison --specs comparison/specs
```

**Exit status 1 is expected**, because the stored images differ. The command checks specification hashes and rendering diagnostics, compares all RGBA channels with zero tolerance, and regenerates the differences and metrics. There are no coverage masks or relaxed thresholds. `--report-only` keeps the measurements while returning success for diagnostic use.

The native reference is an unmodified local build of VTK revision `efc4afbd7430e8eddf86759c5d70711af89e50f0`. Both runtimes used Vulkan with the same SwiftShader driver, shared mesh files checked by SHA-256, explicit cameras/materials/lights, 800 by 800 output, and one sample per pixel. The [native build provenance](comparison/provenance/build-info.json), [capture specifications](comparison/specs), [native source excerpts](comparison/reference-source), captures, raw RGBA, diagnostics, and difference images are committed here. Historical paths in immutable capture metadata identify the original run; verification resolves specifications relative to the supplied directory.

For fresh captures, regenerate specifications in this checkout and follow the [native comparison instructions](Utilities/DeepFramebufferComparison/README.md). Native build products and original scan/CT volumes are excluded; their URLs, hashes, and preparation commands are recorded. The prepared surfaces are included in `Data/deep-transparency` with their manifests.

## Build the hosted gallery

```sh
npm run build:demo
npm run preview:demo
```

The static site is written to `dist/demo`. `SITE_BASE_PATH=/vtk-js-deep-transparency/ npm run build:demo` builds for the GitHub Pages project URL. The Pages workflow deploys this directory from `main`; the source repository retains the comparison evidence. The site includes the prepared meshes and their attribution manifests. Raw volumes and native build products are excluded.

## Browser checks

With the demo server running:

```sh
node Examples/Rendering/DeepFramebufferTransparency/verify.mjs
node Examples/Rendering/DeepFramebufferTransparency/verify-datasets.mjs
node Examples/Rendering/DeepFramebufferTransparency/verify-controls.mjs
node Examples/Rendering/DeepFramebufferTransparency/verify-components.mjs
node Examples/Rendering/DeepFramebufferTransparency/verify-component-layout.mjs
node Examples/Rendering/DeepFramebufferTransparency/verify-gallery.mjs
node Examples/Rendering/DeepFramebufferTransparency/verify-startup.mjs
```

The startup check measures embedded document and frame bounds during loading and resizing, verifies that content fits without hiding scrollbars, and checks progressive loading and retry behavior.

Set `DEMO_URL` for another port and `DEMO_OUTPUT_DIR` to choose the screenshot directory. These checks drive the public demo, require exact draw-order independence, inspect displayed geometry and controls, and reject browser or WebGPU errors. They do not assert native PBR parity. The separate [rendering fixtures](Sources/Rendering/WebGPU/DeepFramebufferPass/test/README.md) include independently rendered OpenGL C++ references with explicitly documented criteria.

On a fresh machine, install the test browser with `npx playwright install chromium` before running browser checks. To verify the committed mesh and capture files byte for byte, run `sha256sum --check provenance/artifacts.sha256`.

## Repository

This repository contains an upstream vtk.js source snapshot followed by the transparency port, demo, prepared data, and comparison evidence. [Source revisions](provenance/source.json) identify its inputs. The original vtk.js project README is preserved as [README.vtk.md](README.vtk.md); vtk.js retains its [BSD license](LICENSE).
