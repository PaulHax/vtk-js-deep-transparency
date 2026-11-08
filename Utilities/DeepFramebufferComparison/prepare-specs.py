#!/usr/bin/env python3
"""Create shared, explicit camera and material specifications for native/browser renders."""

import argparse
import hashlib
import json
import math
from pathlib import Path

import vtk

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "Data/deep-transparency/comparison/specs"
LIGHTS = [
    {"position": [4, 5, 7], "intensity": 0.7, "color": [1, 0.94, 0.86]},
    {"position": [-5, 1, 3], "intensity": 0.3, "color": [0.67, 0.82, 1]},
    {"position": [0, -4, -4], "intensity": 0.5, "color": [0.69, 1, 0.93]},
]
MATERIAL = {
    "metallic": 0.08,
    "roughness": 0.38,
    "ambient": 0.2,
    "diffuse": 0.8,
    "specular": 0.3,
    "specularPower": 35,
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def create_scene(name, source, width, height, pool_layers):
    bounds = [math.inf, -math.inf] * 3
    actors = []
    for entry in source["actors"]:
        mesh_path = ROOT / entry["url"].lstrip("/")
        reader = vtk.vtkXMLPolyDataReader()
        reader.SetFileName(str(mesh_path))
        reader.Update()
        mesh = reader.GetOutput()
        if mesh.GetNumberOfPoints() == 0:
            raise RuntimeError(f"Empty mesh: {mesh_path}")
        mesh_hash = digest(mesh_path)
        if mesh_hash != entry["sha256"]:
            raise RuntimeError(f"Mesh checksum mismatch: {mesh_path}")
        mesh_bounds = mesh.GetBounds()
        for axis in range(3):
            bounds[axis * 2] = min(bounds[axis * 2], mesh_bounds[axis * 2])
            bounds[axis * 2 + 1] = max(bounds[axis * 2 + 1], mesh_bounds[axis * 2 + 1])
        actors.append({
            "path": str(mesh_path),
            "url": entry["url"],
            "sha256": mesh_hash,
            "color": entry["color"],
            "opacity": entry["opacity"],
            "label": entry["label"],
            "pointCount": mesh.GetNumberOfPoints(),
            "triangleCount": mesh.GetNumberOfPolys(),
            "cellCount": mesh.GetNumberOfCells(),
        })
    bounds_center = [(bounds[2 * axis] + bounds[2 * axis + 1]) / 2 for axis in range(3)]
    radius = math.sqrt(sum((bounds[axis * 2 + 1] - bounds_center[axis]) ** 2 for axis in range(3)))
    center = source.get("cameraFocalPoint", bounds_center)
    direction = source["viewDirection"]
    renderer = vtk.vtkRenderer()
    window = vtk.vtkRenderWindow()
    window.SetSize(width, height)
    window.AddRenderer(renderer)
    camera = renderer.GetActiveCamera()
    camera.SetFocalPoint(*center)
    camera.SetPosition(*[center[axis] + direction[axis] * radius * 3 for axis in range(3)])
    camera.SetViewUp(*source["viewUp"])
    camera.ParallelProjectionOn()
    if "parallelScale" in source:
        camera.SetParallelScale(source["parallelScale"])
    else:
        renderer.ResetCamera(bounds)
    renderer.ResetCameraClippingRange(bounds)
    resolved_camera = {
        "position": list(camera.GetPosition()),
        "focalPoint": list(camera.GetFocalPoint()),
        "viewUp": list(camera.GetViewUp()),
        "parallelProjection": True,
        "parallelScale": camera.GetParallelScale(),
        "clippingRange": list(camera.GetClippingRange()),
        "viewAngle": camera.GetViewAngle(),
    }
    lights = [{
        **light,
        "position": [center[axis] + light["position"][axis] * radius for axis in range(3)],
        "focalPoint": center,
        "positional": False,
        "lightType": "SceneLight",
    } for light in LIGHTS]
    return {
        "name": name,
        "width": width,
        "height": height,
        "multiSample": 1,
        "background": source.get("background", [0.055, 0.075, 0.105]),
        "backgroundAlpha": 1,
        "camera": resolved_camera,
        "actors": actors,
        "lights": lights,
        "material": MATERIAL,
        "poolLayers": pool_layers,
        "bounds": bounds,
        "sourceUrl": source.get("sourcePage", source.get("sourceUrl")),
        "sourceCredit": source.get("credit"),
        "simulationTime": source.get("simulationTime"),
        "cycle": source.get("cycle"),
        "cameraGenerator": f"VTK {vtk.vtkVersion.GetVTKVersion()} camera public API; no rendering",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--pool-layers", type=int, default=32)
    args = parser.parse_args()
    if args.width < 1 or args.height < 1 or not 1 <= args.pool_layers <= 64:
        parser.error("Image dimensions must be positive and pool layers must be between 1 and 64")
    args.output.mkdir(parents=True, exist_ok=True)
    scans = json.loads((ROOT / "Data/deep-transparency/scans/manifest.json").read_text())
    impact = json.loads((ROOT / "Data/deep-transparency/impact/manifest.json").read_text())
    sources = {**scans["scenes"], **impact["scenes"]}
    cases = []
    for name in ["bonsai", "engine", "teapot", "impact"]:
        scene = create_scene(name, sources[name], args.width, args.height, args.pool_layers)
        for mode in ["unlit", "pbr"]:
            case_name = f"{name}-{mode}"
            spec = {**scene, "name": case_name, "dataset": name, "mode": mode}
            if mode == "unlit":
                spec["material"] = {**MATERIAL, "ambient": 1, "diffuse": 0, "specular": 0}
            else:
                spec["material"] = {**MATERIAL, "baseIOR": 1.5}
            target = args.output / f"{case_name}.json"
            target.write_text(json.dumps(spec, indent=2) + "\n")
            relative = target.resolve().relative_to(ROOT)
            cases.append({"name": case_name, "path": str(target.resolve()), "url": "/" + relative.as_posix(), "sha256": digest(target)})
            print(target)
    (args.output / "index.json").write_text(json.dumps({"cases": cases}, indent=2) + "\n")


if __name__ == "__main__":
    main()
