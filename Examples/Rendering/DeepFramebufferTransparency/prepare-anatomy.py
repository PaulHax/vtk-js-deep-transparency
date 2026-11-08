#!/usr/bin/env python3
"""Prepare one real, expert-labeled NasalSeg CT case for the sinus demo.

Requires vtk and numpy. Only the six generated VTPs and manifest are needed
by the browser. The 224 MB source archive and extracted NRRDs stay in raw/.
"""

import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import zipfile

import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy


SOURCE_PAGE = "https://zenodo.org/records/13893419"
SOURCE_URL = SOURCE_PAGE + "/files/NasalSeg.zip?download=1"
SOURCE_MD5 = "ba83df47974d907798542101fa43ac7d"
SOURCE_SHA256 = "60c6facf843685802c39e4adff4a05c081c1c4b6175c9cb573745c55abb0fa6a"
SOURCE_BYTES = 224005800
PAPER = "https://doi.org/10.1038/s41597-024-04176-1"
LICENSE = "https://creativecommons.org/licenses/by/4.0/"
FILES = {
    "image": {
        "member": "images/P001_img.nrrd",
        "sha256": "a493bf3ad5bb94f31edc18c16a89ac01d7432604e7f087488bdb3e27bf89d9be",
    },
    "labels": {
        "member": "labels/P001_seg.nrrd",
        "sha256": "511e378f34acad0224ba267830b21236a01bc0c34a6459ca254d2e762125c7c1",
    },
}
PARTS = [
    (1, "right-maxillary", "Right maxillary sinus", [0.20, 0.77, 0.96], 0.76),
    (2, "left-maxillary", "Left maxillary sinus", [0.98, 0.49, 0.25], 0.76),
    (3, "right-nasal", "Right nasal cavity", [0.35, 0.87, 0.57], 0.82),
    (4, "left-nasal", "Left nasal cavity", [0.85, 0.47, 0.93], 0.82),
    (5, "nasopharynx", "Nasopharynx", [0.98, 0.83, 0.29], 0.72),
]


def digest(path, algorithm="sha256"):
    value = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def sources(output, archive):
    raw = output / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    paths = {key: raw / Path(spec["member"]).name for key, spec in FILES.items()}
    if all(path.exists() and digest(path) == FILES[key]["sha256"] for key, path in paths.items()):
        return paths
    archive = archive or raw / "NasalSeg.zip"
    if not archive.exists():
        print(f"Downloading NasalSeg: {SOURCE_URL}", flush=True)
        temporary = archive.with_suffix(".zip.part")
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as response, temporary.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        temporary.replace(archive)
    if archive.stat().st_size != SOURCE_BYTES or digest(archive, "md5") != SOURCE_MD5 or digest(archive) != SOURCE_SHA256:
        raise RuntimeError("NasalSeg archive does not match the published Zenodo checksum")
    with zipfile.ZipFile(archive) as source:
        for key, spec in FILES.items():
            paths[key].write_bytes(source.read(spec["member"]))
            if digest(paths[key]) != spec["sha256"]:
                raise RuntimeError(f"Source checksum mismatch: {spec['member']}")
    return paths


def read_nrrd(path):
    header, payload = path.read_bytes().split(b"\n\n", 1)
    fields = dict(
        line.split(":", 1) for line in header.decode("ascii").splitlines()
        if ":" in line and not line.startswith("#")
    )
    fields = {key: value.strip() for key, value in fields.items()}
    if (fields["dimension"], fields["type"], fields["encoding"], fields["endian"], fields["space"]) != (
        "3", "int16", "gzip", "little", "left-posterior-superior"
    ):
        raise RuntimeError("Unexpected NasalSeg NRRD format")
    dimensions = tuple(map(int, fields["sizes"].split()))
    axes = np.array([
        tuple(map(float, vector.split(",")))
        for vector in re.findall(r"\(([^)]+)\)", fields["space directions"])
    ]).T
    spacing = np.linalg.norm(axes, axis=0)
    direction = axes / spacing
    origin = tuple(map(float, fields["space origin"].strip("()").split(",")))
    values = np.frombuffer(gzip.decompress(payload), dtype="<i2").copy()
    if values.size != int(np.prod(dimensions)):
        raise RuntimeError("NRRD payload length does not match its dimensions")
    image = vtk.vtkImageData()
    image.SetDimensions(*dimensions)
    image.SetSpacing(*spacing)
    image.SetOrigin(*origin)
    image.SetDirectionMatrix(*direction.ravel())
    image.GetPointData().SetScalars(numpy_to_vtk(values, deep=True))
    metadata = {
        "dimensions": list(dimensions),
        "spacing": spacing.tolist(),
        "origin": list(origin),
        "direction": direction.tolist(),
        "spaceDirections": axes.T.tolist(),
        "coordinateSystem": fields["space"],
    }
    return image, values, metadata


def surface(image, values, mask, output, slug, label, color, opacity, label_id=None):
    binary = vtk.vtkImageData()
    binary.CopyStructure(image)
    binary.GetPointData().SetScalars(numpy_to_vtk(mask.astype(np.uint8), deep=True))
    # A one-voxel border closes the clipped CT region at its field of view.
    padded = vtk.vtkImageConstantPad()
    padded.SetInputData(binary)
    dimensions = image.GetDimensions()
    padded.SetOutputWholeExtent(-1, dimensions[0], -1, dimensions[1], -1, dimensions[2])
    padded.SetConstant(0)
    contour = vtk.vtkFlyingEdges3D()
    contour.SetInputConnection(padded.GetOutputPort())
    contour.SetValue(0, 0.5)
    contour.ComputeNormalsOff()
    contour.ComputeScalarsOff()
    smooth = vtk.vtkWindowedSincPolyDataFilter()
    smooth.SetInputConnection(contour.GetOutputPort())
    smooth.SetNumberOfIterations(20)
    smooth.SetPassBand(0.10)
    smooth.BoundarySmoothingOff()
    smooth.FeatureEdgeSmoothingOff()
    smooth.NonManifoldSmoothingOn()
    smooth.NormalizeCoordinatesOn()
    normals = vtk.vtkPolyDataNormals()
    normals.SetInputConnection(smooth.GetOutputPort())
    normals.SplittingOff()
    normals.ConsistencyOn()
    normals.AutoOrientNormalsOn()
    normals.Update()
    mesh = normals.GetOutput()
    if not mesh.GetNumberOfPolys() or not np.isfinite(vtk_to_numpy(mesh.GetPoints().GetData())).all():
        raise RuntimeError(f"Invalid anatomy mesh: {label}")
    filename = f"P001-{slug}.vtp"
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
        "url": f"/Data/deep-transparency/anatomy/{filename}",
        "label": label,
        "color": color,
        "opacity": opacity,
        "triangleCount": mesh.GetNumberOfPolys(),
        "cellCount": mesh.GetNumberOfCells(),
        "pointCount": mesh.GetNumberOfPoints(),
        "bounds": list(mesh.GetBounds()),
        "bytes": target.stat().st_size,
        "sha256": digest(target),
        "sourceVoxelCount": int(np.count_nonzero(mask)),
    }
    if label_id is not None:
        actor["sourceLabel"] = label_id
        actor["segmentedVolumeMM3"] = float(np.count_nonzero(mask) * np.prod(image.GetSpacing()))
        actor["meanSourceHU"] = float(np.mean(values[mask]))
    else:
        actor["thresholdHU"] = 350
    print(f"{label}: {actor['triangleCount']:,} triangles, {actor['bytes']:,} bytes", flush=True)
    return actor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[3] / "Data/deep-transparency/anatomy")
    parser.add_argument("--archive", type=Path, help="An already downloaded, unmodified NasalSeg.zip")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    paths = sources(output, args.archive)
    image, hu, metadata = read_nrrd(paths["image"])
    labels, ids, label_metadata = read_nrrd(paths["labels"])
    if metadata != label_metadata or image.GetBounds() != labels.GetBounds():
        raise RuntimeError("The CT and expert labels are not physically registered")
    if set(np.unique(ids)) != set(range(6)):
        raise RuntimeError("Expected all five anatomical labels and background")
    actors = [surface(image, hu, hu >= 350, output, "bone", "Facial bone (CT contour)", [0.88, 0.87, 0.80], 0.14)]
    for label_id, slug, label, color, opacity in PARTS:
        mask = ids == label_id
        if np.median(hu[mask]) >= -300:
            raise RuntimeError(f"Airway label {label_id} does not overlap air in the paired CT")
        actors.append(surface(image, hu, mask, output, slug, label, color, opacity, label_id))
    scene = {
        "name": "Sinus anatomy",
        "description": "Both maxillary sinuses, the intricate left and right nasal passages, and the nasopharynx from one real human CT, inside translucent facial bone.",
        "note": "Five expert-reviewed NasalSeg labels. Frontal, ethmoid and sphenoid sinuses are not separately annotated. Bone is a 350 HU contour of the same cropped CT.",
        "actors": actors,
        "sourcePage": SOURCE_PAGE,
        "sourceUrl": SOURCE_URL,
        "sourceArchiveBytes": SOURCE_BYTES,
        "sourceArchiveMD5": SOURCE_MD5,
        "sourceArchiveSHA256": SOURCE_SHA256,
        "sourceCase": "P001",
        "sourceFiles": FILES,
        "paper": PAPER,
        "credit": "Yichi Zhang, Jing Wang and colleagues, NasalSeg, Huashan Hospital / Fudan University (2024)",
        "license": "Creative Commons Attribution 4.0 International (Zenodo dataset)",
        "licenseUrl": LICENSE,
        "preprocessing": "Original cropped CT and five expert-reviewed masks in shared LPS coordinates; one-voxel exterior padding; 0.5 binary contour; 20 windowed-sinc iterations, passband 0.10; point normals; no mesh decimation. The bone context uses CT >= 350 HU. CT and label dimensions, direction, origin and spacing must match exactly.",
        "triangleCount": sum(actor["triangleCount"] for actor in actors),
        "cellCount": sum(actor["cellCount"] for actor in actors),
        "viewDirection": [0.8, -3, 0.6],
        "viewUp": [0, 0, 1],
        "background": [0.055, 0.075, 0.105],
        **metadata,
    }
    manifest = {"generator": Path(__file__).name, "vtkVersion": vtk.vtkVersion.GetVTKVersion(), "scenes": {"anatomy": scene}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
