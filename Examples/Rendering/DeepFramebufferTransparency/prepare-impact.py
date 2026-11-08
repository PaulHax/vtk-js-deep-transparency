#!/usr/bin/env python3
"""Prepare genuine LANL Deep Water Impact surfaces for the local WebGPU demo.

Requires Python VTK. Reuses an input VTI with --input, otherwise recovers cycle
21255 from the public research archive linked by WassersteinMergeTreesData.
The archive is streamed only through the requested member, then disconnected.
"""

import argparse
import hashlib
import json
import lzma
from pathlib import Path
import shutil
import tarfile
import urllib.parse
import urllib.request
from html.parser import HTMLParser

import vtk

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE.parents[2] / "Data" / "deep-transparency" / "impact"
ARCHIVE_ID = "1MPYTRxi8ecZUqnthrUmxewtkQcEWYnZE"
MIRROR_SOURCE = "https://github.com/MatPont/WassersteinMergeTreesData/blob/76a681ace218a813c17efa13db4b1cd061e8959b/dataAsteroidImpactTS.sh"
ARTICLE_SOURCE = "https://github.com/sankhesh/vtk-demo-images/blob/bcedd769d813c02ecb30b8ab8733cc1c4fbf06c6/demos/deep-framebuffer/render-impact.cxx"
CREDIT = "John M. Patchett and Galen R. Gisler, Los Alamos National Laboratory, LA-UR-17-21595. Simulation data produced under the auspices of the U.S. Department of Energy."
FIELDS = [
    ("water", "v02", 0.5, [0.38, 0.8, 0.94], 0.38, "Water"),
    ("temperature", "tev", 0.09, [1, 0.8, 0.35], 0.24, "Temperature"),
    ("asteroid", "v03", 0.1, [0.88, 0.32, 0.15], 0.55, "Asteroid material"),
]


class DownloadForm(HTMLParser):
    def __init__(self):
        super().__init__()
        self.action = None
        self.fields = {}

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "form" and attrs.get("id") == "download-form":
            self.action = attrs["action"]
        if tag == "input" and attrs.get("type") == "hidden":
            self.fields[attrs["name"]] = attrs.get("value", "")


def archive_url():
    url = f"https://drive.google.com/uc?export=download&id={ARCHIVE_ID}"
    with urllib.request.urlopen(url, timeout=60) as response:
        if "text/html" not in response.headers.get("content-type", ""):
            return url
        form = DownloadForm()
        form.feed(response.read().decode())
    if form.action != "https://drive.usercontent.google.com/download":
        raise RuntimeError("The public mirror did not supply its expected download form")
    return form.action + "?" + urllib.parse.urlencode(form.fields)


def recover_timestep(output, cycle):
    name = f"pv_insitu_300x300x300_{cycle:05d}.vti"
    path = output / "raw" / name
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(archive_url(), timeout=60) as source:
        with lzma.LZMAFile(source) as decoded:
            with tarfile.open(fileobj=decoded, mode="r|") as archive:
                for member in archive:
                    print(f"Reading preserved archive: {member.name} ({member.size} bytes)", flush=True)
                    if Path(member.name).name != name:
                        continue
                    temporary = path.with_suffix(".vti.part")
                    with archive.extractfile(member) as reader, temporary.open("wb") as writer:
                        shutil.copyfileobj(reader, writer, length=1024 * 1024)
                    temporary.rename(path)
                    return path
    raise RuntimeError(f"The preserved archive does not contain {name}")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prepare(input_path, output):
    reader = vtk.vtkXMLImageDataReader()
    reader.SetFileName(str(input_path))
    reader.Update()
    image = reader.GetOutput()
    if image.GetDimensions() != (300, 300, 300):
        raise RuntimeError(f"Unexpected image dimensions: {image.GetDimensions()}")
    for field in ["tev", "v02", "v03"]:
        if image.GetPointData().GetArray(field) is None:
            raise RuntimeError(f"The input is missing the real {field} field")
    field_data = image.GetFieldData()
    if field_data.GetArray("simulated_time") is None or field_data.GetArray("cycle_index") is None:
        raise RuntimeError("The input does not record its simulation time and cycle")
    simulation_time = field_data.GetArray("simulated_time").GetTuple1(0)
    cycle = int(field_data.GetArray("cycle_index").GetTuple1(0))
    actors = []
    for name, field, value, color, opacity, label in FIELDS:
        image.GetPointData().SetActiveScalars(field)
        image.Modified()
        contour = vtk.vtkFlyingEdges3D()
        contour.SetInputData(image)
        contour.SetValue(0, value)
        contour.ComputeNormalsOff()
        contour.InterpolateAttributesOff()
        normals = vtk.vtkPolyDataNormals()
        normals.SetInputConnection(contour.GetOutputPort())
        normals.SplittingOff()
        normals.ConsistencyOn()
        normals.Update()
        mesh = vtk.vtkPolyData()
        mesh.ShallowCopy(normals.GetOutput())
        if mesh.GetNumberOfPolys() == 0:
            raise RuntimeError(f"The {field} contour is empty at {value}")
        surface_normals = mesh.GetPointData().GetNormals()
        mesh.GetPointData().Initialize()
        mesh.GetPointData().SetNormals(surface_normals)
        mesh.GetCellData().Initialize()
        mesh.GetFieldData().Initialize()
        target = output / f"{name}.vtp"
        writer = vtk.vtkXMLPolyDataWriter()
        writer.SetInputData(mesh)
        writer.SetFileName(str(target))
        writer.SetDataModeToBinary()
        writer.SetCompressorTypeToZLib()
        writer.SetHeaderTypeToUInt32()
        writer.SetIdTypeToInt32()
        if not writer.Write():
            raise RuntimeError(f"Failed writing {target}")
        actors.append({
            "url": f"/Data/deep-transparency/impact/{name}.vtp",
            "color": color, "opacity": opacity, "label": label,
            "field": field, "isovalue": value,
            "triangleCount": mesh.GetNumberOfPolys(), "pointCount": mesh.GetNumberOfPoints(),
            "bounds": list(mesh.GetBounds()), "bytes": target.stat().st_size,
            "sha256": sha256(target),
        })
        print(f"Wrote {name}: {mesh.GetNumberOfPolys()} triangles", flush=True)
    different_frame = cycle != 22198
    time_label = f"{simulation_time:.5f} s"
    frame_note = (
        f"Recovered yA31 cycle {cycle} ({time_label}) from a public research mirror. "
        "The blog uses cycle 22198 at 12.00047 s; its LANL download is currently unavailable. "
        if different_frame else "The exact yA31 frame used in the blog. "
    )
    scene = {
        "name": "Asteroid impact",
        "description": f"LANL Deep Water Impact: a 250 m asteroid entering at 45 degrees, with no prescribed airburst, at {time_label}.",
        "note": frame_note + "Three original scalar fields are contoured directly at the blog's thresholds, with full 300-cubed resolution and physical spacing.",
        "ensemble": "yA31", "cycle": cycle, "simulationTime": simulation_time,
        "blogCycle": 22198, "blogSimulationTime": 12.00047,
        "differentFrameFromBlog": different_frame,
        "actors": actors, "defaultOpacity": 0.38, "controlledActors": [0],
        "viewDirection": [1.4, 0.65, 2], "viewUp": [0, 1, 0],
        "cameraFocalPoint": [-300000, 700000, 0], "parallelScale": 2200000 / 0.95,
        "background": [0.055, 0.075, 0.105],
        "sourceUrl": MIRROR_SOURCE if different_frame else "https://oceans11.lanl.gov/deepwaterimpact/",
        "downloadUrl": f"https://drive.google.com/file/d/{ARCHIVE_ID}/view",
        "processingSource": ARTICLE_SOURCE, "license": "Public release LA-UR-17-21595",
        "credit": CREDIT,
        "mirrorCredit": "Mathieu Pont, Jules Vidal, Julie Delon and Julien Tierny, Wasserstein Distances, Geodesics and Barycenters of Merge Trees, IEEE TVCG, 2021.",
        "input": {"file": input_path.name, "sha256": sha256(input_path), "dimensions": list(image.GetDimensions()), "origin": list(image.GetOrigin()), "spacing": list(image.GetSpacing())},
        "processing": "vtkFlyingEdges3D followed by vtkPolyDataNormals with splitting off and consistency on. No resampling, smoothing, subsetting or decimation.",
        "vtkVersion": vtk.vtkVersion.GetVTKVersion(),
    }
    (output / "manifest.json").write_text(json.dumps({"scenes": {"impact": scene}}, indent=2) + "\n")
    print(f"Prepared cycle {cycle}, time {time_label}; {sum(a['triangleCount'] for a in actors)} total triangles", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Existing genuine LANL VTI file, including the exact blog frame if available")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--cycle", type=int, default=21255, help="Cycle in the preserved archive (default: 21255)")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    prepare(args.input or recover_timestep(args.output, args.cycle), args.output)


if __name__ == "__main__":
    main()
