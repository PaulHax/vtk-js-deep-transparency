#!/usr/bin/env python3
"""Download the article's CT scans and export its polygonal contour scenes.

Run with Python containing vtk and numpy. Downloads and generated meshes stay
under the repository's ignored Data directory. The source volumes are checked
against the published SHA-512 values before any contours are generated.
"""

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk

AUTHOR_COMMIT = "bcedd769d813c02ecb30b8ab8733cc1c4fbf06c6"
PIPELINE_URL = (
    "https://github.com/sankhesh/vtk-demo-images/blob/"
    + AUTHOR_COMMIT
    + "/demos/deep-framebuffer/render-scenes.cxx"
)

SCANS = {
    "bonsai": {
        "name": "Bonsai",
        "dimensions": [256, 256, 256],
        "thresholds": [35, 100],
        "colors": [[0.27, 0.78, 0.64], [0.98, 0.73, 0.42]],
        "opacities": [0.28, 0.68],
        "labels": ["Foliage and outer structure", "Trunk, branches and soil"],
        "viewDirection": [1.3, 0.8, 2],
        "viewUp": [0, 1, 0],
        "credit": "volvis.org and S. Roettger, VIS, University of Stuttgart",
        "sha512": "b34156a0ffc80ffaf84d069f3d05a40fdd999a35f05492829a2b0c13403a3147e73712b1d10c2cc34da66a59540a1632dae6adc96f3ebf3efa5d4d6c10598997",
        "expectedArticleCells": 1100146,
        "description": "The original Bonsai CT scan, with translucent foliage revealing the denser trunk and branches.",
        "note": "The foliage contour at 35 surrounds the denser trunk and branches at 100. Near leaves attenuate the structures behind them.",
    },
    "engine": {
        "name": "Engine",
        "dimensions": [256, 256, 128],
        "thresholds": [60, 160],
        "colors": [[0.65, 0.45, 0.83], [0.70, 0.88, 0.48]],
        "opacities": [0.36, 0.76],
        "labels": ["Outer casing", "Dense inner structure"],
        "viewDirection": [1.4, -1.8, 1.5],
        "viewUp": [0, 0, 1],
        "credit": "volvis.org and General Electric",
        "sha512": "f17228483b1b5edb90146eac90ba979531629a2880d9e7a0493a98290da8af6ac2cf80f2c567a3d08695dc7dd854916c861dad8856b2d5721501954e913de13f",
        "expectedArticleCells": 723952,
        "description": "The original engine-block CT scan, with a violet outer contour and pale-green internal structure.",
        "note": "The violet contour at 60 reveals the pale-green inner structure at 160. Orbit to follow the channels through the casing.",
    },
    "teapot": {
        "name": "Boston Teapot",
        "sourceId": "boston_teapot",
        "dimensions": [256, 256, 178],
        "thresholds": [50, 65],
        "colors": [[0.24, 0.72, 0.82], [1.0, 0.63, 0.26]],
        "opacities": [0.16, 0.85],
        "labels": ["Teapot shell", "Lobster model"],
        "viewDirection": [1.3, 0.6, 2],
        "viewUp": [0, 1, 0],
        "credit": "volvis.org and Terarecon Inc, MERL, Brigham and Women's Hospital",
        "sha512": "b2bf7ba8ba7a7d5a8ea76ccd8fd2c0f5f043079a83cd6a3055e85f5e0a40c1c4d872b9bbc7aedf628989eb57bffd5729767c29fe8ae018c581406b196caa6359",
        "expectedArticleCells": 573892,
        "description": "The original Boston Teapot CT scan contains a lobster model inside the transparent enclosure.",
        "note": "The teal enclosure at 50 surrounds an isolated lobster contour at 65. The front shell attenuates the lobster; the rear shell stays behind it.",
    },
}


def sha(path, algorithm="sha256"):
    return hashlib.new(algorithm, path.read_bytes()).hexdigest()


def download_volume(key, specification, output):
    source_id = specification.get("sourceId", key)
    dimensions = "x".join(map(str, specification["dimensions"]))
    filename = f"{source_id}_{dimensions}_uint8.raw"
    url = f"http://klacansky.com/open-scivis-datasets/{source_id}/{filename}"
    path = output / "raw" / filename
    expected_size = int(np.prod(specification["dimensions"]))
    if not path.exists():
        print(f"Downloading {specification['name']}: {url}", flush=True)
        temporary = path.with_suffix(".raw.part")
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as stream:
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
        temporary.replace(path)
    if path.stat().st_size != expected_size or sha(path, "sha512") != specification["sha512"]:
        raise RuntimeError(f"Source validation failed: {path}")
    return path, url


def contour_scene(key, specification, output):
    path, source_url = download_volume(key, specification, output)
    image = vtk.vtkImageData()
    image.SetDimensions(*specification["dimensions"])
    image.SetSpacing(1, 1, 1)
    scalars = numpy_to_vtk(np.fromfile(path, dtype=np.uint8), deep=True)
    scalars.SetName("Density")
    image.GetPointData().SetScalars(scalars)
    cast = vtk.vtkImageCast()
    cast.SetInputData(image)
    cast.SetOutputScalarTypeToFloat()
    actors = []
    for index, threshold in enumerate(specification["thresholds"]):
        sigma = 0.65 if key == "teapot" and index == 1 else 1.0
        smooth = vtk.vtkImageGaussianSmooth()
        smooth.SetInputConnection(cast.GetOutputPort())
        smooth.SetStandardDeviations(sigma, sigma, sigma)
        smooth.SetRadiusFactors(2, 2, 2)
        contour = vtk.vtkFlyingEdges3D()
        contour.SetInputConnection(smooth.GetOutputPort())
        resampling = None
        if key == "teapot" and index == 1:
            resize = vtk.vtkImageResize()
            resize.SetInputConnection(smooth.GetOutputPort())
            interpolator = vtk.vtkImageInterpolator()
            interpolator.SetInterpolationModeToCubic()
            resize.SetInterpolator(interpolator)
            resize.SetResizeMethodToMagnificationFactors()
            resize.SetMagnificationFactors(2, 2, 2)
            resize.BorderOff()
            resize.Update()
            contour.SetInputConnection(resize.GetOutputPort())
            resampling = {
                "factor": 2,
                "interpolation": "cubic",
                "dimensions": list(resize.GetOutput().GetDimensions()),
                "spacing": list(resize.GetOutput().GetSpacing()),
                "bounds": list(resize.GetOutput().GetBounds()),
            }
            if not np.allclose(resampling["bounds"], image.GetBounds(), atol=1e-8):
                raise RuntimeError("Lobster interpolation changed physical bounds")
        contour.SetValue(0, threshold)
        contour.ComputeNormalsOff()
        normals = vtk.vtkPolyDataNormals()
        if key == "teapot":
            connectivity = vtk.vtkPolyDataConnectivityFilter()
            connectivity.SetInputConnection(contour.GetOutputPort())
            if index == 0:
                connectivity.SetExtractionModeToLargestRegion()
            else:
                connectivity.SetExtractionModeToClosestPointRegion()
                connectivity.SetClosestPoint(139, 140, 88)
            clean = vtk.vtkCleanPolyData()
            clean.SetInputConnection(connectivity.GetOutputPort())
            normals.SetInputConnection(clean.GetOutputPort())
        else:
            normals.SetInputConnection(contour.GetOutputPort())
        normals.SplittingOff()
        normals.ConsistencyOn()
        normals.Update()
        mesh = vtk.vtkPolyData()
        mesh.ShallowCopy(normals.GetOutput())
        mesh.GetPointData().SetScalars(None)
        filename = f"{key}-{threshold}.vtp"
        target = output / filename
        writer = vtk.vtkXMLPolyDataWriter()
        writer.SetFileName(str(target))
        writer.SetInputData(mesh)
        writer.SetDataModeToBinary()
        writer.SetCompressorTypeToZLib()
        writer.SetCompressionLevel(6)
        writer.SetIdTypeToInt32()
        if writer.Write() != 1:
            raise RuntimeError(f"Failed writing {target}")
        actor = {
            "url": f"/Data/deep-transparency/scans/{filename}",
            "color": specification["colors"][index],
            "opacity": specification["opacities"][index],
            "label": specification["labels"][index],
            "threshold": threshold,
            "sigma": sigma,
            "triangleCount": mesh.GetNumberOfPolys(),
            "cellCount": mesh.GetNumberOfCells(),
            "lineCount": mesh.GetNumberOfLines(),
            "vertexCellCount": mesh.GetNumberOfVerts(),
            "pointCount": mesh.GetNumberOfPoints(),
            "bounds": list(mesh.GetBounds()),
            "bytes": target.stat().st_size,
            "sha256": sha(target),
        }
        if resampling:
            actor["resampling"] = resampling
        actors.append(actor)
        print(f"{key} {threshold}: {actor['triangleCount']:,} triangles, {actor['bytes']:,} bytes", flush=True)
    triangle_count = sum(actor["triangleCount"] for actor in actors)
    cell_count = sum(actor["cellCount"] for actor in actors)
    if cell_count != specification["expectedArticleCells"]:
        raise RuntimeError(
            f"{key}: expected {specification['expectedArticleCells']} article cells, got {cell_count}"
        )
    return {
        "name": specification["name"],
        "description": specification["description"],
        "thresholds": specification["thresholds"],
        "actors": actors,
        "sourceUrl": source_url,
        "sourcePage": "http://klacansky.com/open-scivis-datasets/#" + specification.get("sourceId", key),
        "credit": specification["credit"],
        "license": "See original Open SciVis dataset terms and credits",
        "dimensions": specification["dimensions"],
        "spacing": [1, 1, 1],
        "scalarType": "uint8",
        "sourceBytes": path.stat().st_size,
        "sourceSHA256": sha(path),
        "sourceSHA512": specification["sha512"],
        "pipelineSource": PIPELINE_URL,
        "triangleCount": triangle_count,
        "cellCount": cell_count,
        "articleReportedTriangleCount": specification["expectedArticleCells"],
        "viewDirection": specification["viewDirection"],
        "viewUp": specification["viewUp"],
        "background": [0.055, 0.075, 0.105],
        "note": specification["note"],
        "preprocessing": "Original scan and article contours, without mesh decimation. Gaussian smoothing sigma 1 voxel, except the lobster at 0.65 voxels with cubic half-voxel resampling.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[3] / "Data/deep-transparency/scans")
    parser.add_argument("--only", choices=list(SCANS), nargs="+")
    args = parser.parse_args()
    output = args.output.resolve()
    (output / "raw").mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if args.only and manifest_path.exists() else {"scenes": {}}
    manifest["generator"] = Path(__file__).name
    manifest["vtkVersion"] = vtk.vtkVersion.GetVTKVersion()
    manifest["articleSourceCommit"] = AUTHOR_COMMIT
    for key in args.only or SCANS:
        manifest["scenes"][key] = contour_scene(key, SCANS[key], output)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    main()
