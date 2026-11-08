#!/usr/bin/env python3
"""Render the shared scenes with native VTK's C++ OpenGL depth peeling.

Usage: python generate-native-baselines.py [--output DIRECTORY]
Requires vtk and Pillow. No browser image is used as a reference.
"""

import argparse
import hashlib
import json
from pathlib import Path

import vtk
from PIL import Image

HERE = Path(__file__).resolve().parent
VTK_REFERENCE_COMMIT = "efc4afbd7430e8eddf86759c5d70711af89e50f0"


def make_actor(layer, meshes):
    points = vtk.vtkPoints()
    triangles = vtk.vtkCellArray()
    if "mesh" in layer:
        mesh = meshes[layer["mesh"]]
        for offset in range(0, len(mesh["points"]), 3):
            points.InsertNextPoint(*mesh["points"][offset:offset + 3])
        for offset in range(0, len(mesh["triangles"]), 4):
            triangles.InsertNextCell(3, mesh["triangles"][offset + 1:offset + 4])
    else:
        xmin, xmax, ymin, ymax = layer["bounds"]
        depth = layer.get("depth", 0)
        slope = layer.get("slope", 0)
        for x, y in [(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)]:
            points.InsertNextPoint(x, y, depth + slope * x)
        for triangle in [(0, 1, 2), (0, 2, 3)]:
            triangles.InsertNextCell(3, triangle)
    data = vtk.vtkPolyData()
    data.SetPoints(points)
    data.SetPolys(triangles)
    mapper = vtk.vtkPolyDataMapper()
    mapper.SetInputData(data)
    mapper.ScalarVisibilityOff()
    actor = vtk.vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(*layer["color"])
    actor.GetProperty().SetOpacity(layer["opacity"])
    actor.GetProperty().LightingOff()
    return actor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE / "baselines")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    specification_path = HERE / "scenes.json"
    specification = json.loads(specification_path.read_text())
    meshes_path = HERE / "meshes.json"
    meshes = json.loads(meshes_path.read_text())
    manifest = {
        "generator": Path(__file__).name,
        "vtkVersion": vtk.vtkVersion.GetVTKVersion(),
        "backend": "C++ VTK OpenGL dual depth peeling (Python bindings)",
        "deepFramebufferSourceCommit": VTK_REFERENCE_COMMIT,
        "deepFramebufferSource": "https://github.com/Kitware/VTK/blob/"
        + VTK_REFERENCE_COMMIT
        + "/Rendering/WebGPU/vtkWebGPUDeepFramebuffer.cxx",
        "specificationSHA256": hashlib.sha256(specification_path.read_bytes()).hexdigest(),
        "meshesSHA256": hashlib.sha256(meshes_path.read_bytes()).hexdigest(),
        "settings": {"multisamples": 0, "maximumPeels": 64, "occlusionRatio": 0},
        "comparisonScope": "Unlit polygonal alpha compositing. Native WebGPU was not available. "
        "Depth peeling supplies independently rendered depth-ordered reference images. "
        "The deep framebuffer packs fragments to RGBA8 before resolving; general colors "
        "and opacities can differ from depth peeling by quantization.",
        "images": {},
    }
    for name, layers in specification["scenes"].items():
        renderer = vtk.vtkRenderer()
        renderer.SetBackground(*specification["background"])
        renderer.SetBackgroundAlpha(1)
        renderer.SetUseDepthPeeling(True)
        renderer.SetUseOIT(False)
        renderer.SetMaximumNumberOfPeels(64)
        renderer.SetOcclusionRatio(0)
        for layer in layers:
            renderer.AddActor(make_actor(layer, meshes))
        camera = renderer.GetActiveCamera()
        camera.ParallelProjectionOn()
        camera.SetPosition(*specification["camera"]["position"])
        camera.SetFocalPoint(*specification["camera"]["focalPoint"])
        camera.SetViewUp(*specification["camera"]["viewUp"])
        camera.SetParallelScale(specification["camera"]["parallelScale"])
        camera.SetClippingRange(*specification["camera"]["clippingRange"])
        window = vtk.vtkRenderWindow()
        window.SetOffScreenRendering(True)
        window.SetAlphaBitPlanes(True)
        window.SetMultiSamples(0)
        window.SetSize(specification["size"], specification["size"])
        window.AddRenderer(renderer)
        window.Render()
        if not renderer.GetLastRenderingUsedDepthPeeling():
            raise RuntimeError("Native renderer did not use depth peeling; refusing invalid baseline")
        image_filter = vtk.vtkWindowToImageFilter()
        image_filter.SetInput(window)
        image_filter.SetInputBufferTypeToRGB()
        image_filter.ReadFrontBufferOff()
        image_filter.Update()
        output = args.output / f"{name}.png"
        writer = vtk.vtkPNGWriter()
        writer.SetFileName(str(output))
        writer.SetInputConnection(image_filter.GetOutputPort())
        writer.Write()
        image = Image.open(output).convert("RGBA")
        image.save(output)
        manifest["images"][name] = {
            "file": output.name,
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "centerRGBA": list(image.getpixel((specification["size"] // 2,) * 2)),
            "usedDepthPeeling": True,
            "renderWindowClass": window.GetClassName(),
        }
        window.Finalize()
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
