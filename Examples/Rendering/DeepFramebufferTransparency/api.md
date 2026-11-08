This WebGPU example compares vtk.js weighted transparency with the deep framebuffer. Each pair of viewports uses the same actors, camera, lights, and material properties. The default page is a scrolling gallery containing eight scenes: the VTK article's four scan and simulation scenes, real sinus anatomy, a mechanical bearing assembly, and two compositing examples. Anchor links across the top jump to each example.

Run from the repository root:

```sh
npm run example -- DeepFramebufferTransparency --no-browser --host 127.0.0.1 --port 9999
```

Open [http://localhost:9999](http://localhost:9999) in a browser with WebGPU and hardware acceleration enabled. Localhost is a secure context for WebGPU. Examples initialize progressively, with at most two loading at once. Spinners show queued and active loading states; every example starts automatically and remains available after loading. Each scene draws its initial view, then renders in response to interaction or resizing; there is no continuous animation loop. The gallery order is Bonsai, Engine, sinus anatomy, asteroid impact, the bearing assembly, Boston Teapot, intersecting rings, and the two-layer proof.

Every example uses endpoint-based quaternion arcball controls with a smooth sphere/hyperbola transition at the rim: left drag rotates with free roll and right drag pans. Click a view to focus it before using the mouse wheel to zoom about the nearest surface on the cursor ray. Unfocused views leave wheel events to page scrolling; Escape releases focus. GPU depth picking supplies the surface point; over background, zoom uses the point on the camera's focal plane. Either viewport controls that example's shared camera. The examples' cameras are independent of one another. The small Reset camera button beside the component controls restores the example's initial camera. Each colored component row below the viewports has an eye button that shows or hides that component and a separate opacity slider from 0% to 100%. Both controls affect the component in both viewports. Visibility and opacity are independent: hiding a component preserves its opacity, and setting opacity to 0% does not change its visibility flag.

Every scene has a model attribution caption beneath the viewports. Imported models name the data creators, link to the source, show a published license link when available, and describe the conversion into rendered surfaces. NasalSeg links directly to its CC BY 4.0 license and identifies the smoothed label surfaces and CT-derived facial bone. The impact caption credits both LANL's original simulation and the research mirror. The generated bearing and two compositing examples are labeled as original procedural geometry. The manifests retain the detailed sources, processing parameters, credits, and hashes, and record that the scan source page does not specify a license.

- **Bonsai:** foliage at isovalue 35 and dense trunk and branches at 100, with opacities 0.28 and 0.68.
- **Engine:** outer casing at 60 and dense internal structure at 160, with opacities 0.36 and 0.76.
- **Boston Teapot:** exterior shell at 50 and the interior lobster model at 65, with opacities 0.16 and 0.85.
- **Asteroid ocean impact:** the original LANL yA31 simulation's water fraction at 0.5, temperature at 0.09 eV, and asteroid fraction at 0.1, with opacities 0.38, 0.24, and 0.55. The recovered public mirror contains cycle 21255 at **11.00054 seconds**. The article uses cycle 22198 at **12.00047 seconds**; the demo labels the different frame explicitly.
- **Sinus anatomy:** left and right maxillary sinuses, left and right nasal cavities, and the nasopharynx from NasalSeg human CT case P001. Translucent facial bone supplies context, and the component controls reveal the intertwined nasal passages. The source covers a cropped sinonasal region. Frontal, ethmoid and sphenoid sinuses are not separately annotated or claimed as labeled parts.
- **Ball-bearing assembly:** twelve rolling balls fit between grooved inner and outer races inside a pocketed retainer cage. The translucent outer race exposes the component fit. This parametric illustration uses millimetres and is not a manufacturing specification.

The scan volumes come from [Open SciVis Datasets](http://klacansky.com/open-scivis-datasets/), curated by Pavol Klacansky. The preparation script checks the published SHA-512 hashes and reproduces the [author's contour pipeline](https://github.com/sankhesh/vtk-demo-images/tree/main/demos/deep-framebuffer), including smoothing and the teapot component extraction. The resulting meshes are not decimated; their contours and smoothing follow the recorded preparation pipeline. Prepared meshes and manifests are committed under `Data/deep-transparency`; raw source volumes remain excluded. The browser loads prepared meshes from the gallery's own origin and does not fetch raw volumes from the original dataset hosts.

Prepare the scans with a Python environment containing `vtk` and `numpy`:

```sh
python Examples/Rendering/DeepFramebufferTransparency/prepare-scans.py
```

Recover and contour the impact simulation with the companion script, or supply an existing VTI file with `--input`:

```sh
python Examples/Rendering/DeepFramebufferTransparency/prepare-impact.py
```

The recovery script streams a genuine simulation frame from the public research archive linked by [WassersteinMergeTreesData](https://github.com/MatPont/WassersteinMergeTreesData). All three original 300 by 300 by 300 scalar fields and their physical spacing are preserved. The script records the mirror, file hash, ensemble, simulation cycle, and measured simulation time in the local manifest.

Prepare the anatomy and bearing examples with the same Python dependencies:

```sh
python Examples/Rendering/DeepFramebufferTransparency/prepare-anatomy.py
python Examples/Rendering/DeepFramebufferTransparency/prepare-cad.py
```

The anatomy script downloads the 224 MB [NasalSeg archive](https://zenodo.org/records/13893419), verifies its published MD5 and pinned SHA-256 hashes, and extracts case P001. The dataset is credited to Yichi Zhang, Jing Wang and colleagues, Huashan Hospital / Fudan University (2024), under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Its five masks were manually refined and expert-reviewed as described in the [NasalSeg paper](https://doi.org/10.1038/s41597-024-04176-1). The dataset's Zenodo license governs these assets independently of the paper's license. The script preserves the CT and masks' shared physical origin, spacing, directions and LPS coordinates, smooths the label surfaces, and generates the bone context at 350 HU. The manifest records these modifications and source hashes. The bearing script generates its four components locally without downloading data.

The manifests record sources, data hashes, dimensions, contour thresholds, generated mesh hashes, and credits. Missing data displays an inline loading error and retry action. Gallery anchors such as [Sinus anatomy](http://localhost:9999/#anatomy) and [Ball-bearing assembly](http://localhost:9999/#cad) jump directly to the corresponding section. Each section's Open separately link opens a standalone viewer. Direct links such as [Bonsai](http://localhost:9999/?scene=bonsai), [Engine](http://localhost:9999/?scene=engine), and [Boston Teapot](http://localhost:9999/?scene=teapot) also open that standalone viewer, where the scene selector switches examples.

The procedural scenes need no downloaded data:

- **Intersecting rings:** three translucent torus surfaces with front-to-back order that varies across the image.
- **Two-layer proof:** unlit red and blue rectangles over black, matching the basic composition experiment in [Better Transparency with VTK and WebGPU](https://www.kitware.com/better-transparency-with-vtk-and-webgpu/). At opacity 0.5, the overlap should be red-dominant when red is in front and blue-dominant after swapping depths. Reversing draw order leaves those depths unchanged.

The comparison uses one sample per pixel by default. The deep framebuffer sorts up to sixteen collected fragments per sample and packs their color and opacity to RGBA8 before composition. Its bounded shared fragment pool and retained-fragment limit mean sufficiently complex overlap can omit fragments. This is polygonal transparency; it does not interleave translucent surfaces with volume ray integration.

Enable the pass on a renderer with `renderer.setUseDeepFramebufferTransparency(true)`. The shaded scenes use PBR materials and three directional lights. Their translucent properties explicitly select blending with `actor.getProperty().setAlphaMode(2)`.

The standalone viewer's browser console exposes `demo`; each gallery example exposes the same API within its frame. Its `ready` promise resolves after device initialization and the first completed GPU submission. Scene controls also return promises that resolve after GPU completion:

```js
await demo.ready;
await demo.setScene('bonsai');
await demo.setScene('engine');
await demo.setScene('anatomy');
await demo.setComponentOpacity(0, 0.1); // Set facial bone opacity to 10%.
await demo.setComponentVisibility(0, false); // Hide the facial bone.
await demo.setScene('cad');
await demo.setScene('layers');
await demo.setOpacity(0.5);
await demo.swapDepths();
await demo.reverseOrder();
```

`demo.setComponentOpacity(index, value)` accepts opacity from 0 to 1. The console helper `demo.setOpacity(value)` also remains available: it changes the scene's configured group of actors, which is the first component for dataset and assembly scenes and all actors for either compositing example. It has no separate global slider in the UI.

After dispatching pointer or wheel input, `await demo.controls.whenIdle()` waits for pending surface picks, camera changes and GPU rendering to finish. This public completion promise allows interaction checks and screenshots without fixed delays.

The [rendering regression tests](../../../Sources/Rendering/WebGPU/DeepFramebufferPass/test/README.md) include independently rendered C++ VTK OpenGL depth-peeling references. Four planar images match exactly; two curved scenes use explicit one-pixel boundary and one-channel-level precision allowances. The separate [native WebGPU comparison](../../../Utilities/DeepFramebufferComparison/README.md) runs a local C++ VTK WebGPU reference and the browser renderer against shared geometry, camera, materials and lights. It compares every RGBA channel with zero tolerance and saves both captures, differences and metrics. The eight full-dataset cases, four unlit and four PBR, currently fail that strict criterion. Passing the small regression fixtures does not establish pixel-perfect agreement with native C++ VTK WebGPU.

With the example server running, run the repeatable browser check from the repository root:

```sh
node Examples/Rendering/DeepFramebufferTransparency/verify.mjs
```

The procedural check launches Chromium with a software WebGPU adapter, checks every deep viewport for exact image equality after reversing actor order, verifies both rectangle overlap colors, checks the opacity control and responsive layout, and fails on browser or WebGPU errors. It also compares screenshots of the displayed canvas while changing from one sample to four samples and back, changing opacity and depth order, and requiring exact restoration of each original single-sample image. It waits for GPU completion without fixed delays. Screenshots and a JSON report are written to `/tmp/deep-transparency-demo`.

The scrolling gallery has a separate browser check:

```sh
node Examples/Rendering/DeepFramebufferTransparency/verify-gallery.mjs
```

It checks loading and anchor navigation, visible models and attribution captions, idle rendering, focused wheel zoom, arcball and pan interaction, and responsive layout. It saves screenshots and a JSON report under `comparison/gallery`.

For a focused check of wrapping component groups, label-to-slider spacing, and the camera reset button at desktop and mobile widths:

```sh
node Examples/Rendering/DeepFramebufferTransparency/verify-component-layout.mjs
```

Screenshots and measurements are saved under `comparison/component-layout`.

Check startup sizing and progressive loading with:

```sh
node Examples/Rendering/DeepFramebufferTransparency/verify-startup.mjs
```

This check measures embedded document and frame bounds throughout loading and resizing, requiring content to fit without scrollbar-hiding rules. It also checks the two-example loading limit, automatic queue completion, and an isolated loading failure followed by retry. Screenshots and measurements are saved under `comparison/loading`.

Use `DEMO_URL` for a different local server and `DEMO_OUTPUT_DIR` for a different artifact directory:

```sh
DEMO_URL=http://127.0.0.1:9999 DEMO_OUTPUT_DIR=/tmp/transparency-check node Examples/Rendering/DeepFramebufferTransparency/verify.mjs
```

To verify all six prepared dataset and assembly scenes:

```sh
node Examples/Rendering/DeepFramebufferTransparency/verify-datasets.mjs
```

This check covers Bonsai, Engine, Boston Teapot, impact, sinus anatomy, and the bearing assembly. It verifies each displayed model against its manifest and mesh hashes, reverses the actor order and requires identical deep-rendered pixels, checks manifest material opacities, and saves screenshots with a JSON report under `Utilities/TestResults/deep-transparency/datasets`. Use `DATASET_SCENES=bonsai,engine,teapot` to check only the article's CT scans. `DEMO_URL` and `DEMO_OUTPUT_DIR` select the server and artifact directory as for the procedural check. This draw-order check is separate from the strict native comparison.
