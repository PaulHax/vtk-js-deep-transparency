#!/usr/bin/env python3
"""Build a fitted parametric ball-bearing assembly for the transparency demo.

Requires VTK and NumPy. Dimensions are millimetres. The assembly illustrates
part clearances and raceway geometry; it is not a manufacturing specification.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk

HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE.parents[2] / "Data/deep-transparency/cad"
SCALE = 10.0
PITCH_RADIUS = 3.3
BALL_RADIUS = 0.68
GROOVE_RADIUS = 0.687
BALL_COUNT = 12
SEGMENTS = 192


def normals(mesh):
    normal_filter = vtk.vtkPolyDataNormals()
    normal_filter.SetInputData(mesh)
    normal_filter.SplittingOff()
    normal_filter.ConsistencyOn()
    normal_filter.AutoOrientNormalsOn()
    normal_filter.Update()
    output = vtk.vtkPolyData()
    output.DeepCopy(normal_filter.GetOutput())
    surface_normals = output.GetPointData().GetNormals()
    output.GetPointData().Initialize()
    output.GetPointData().SetNormals(surface_normals)
    output.GetCellData().Initialize()
    return output


def revolve(profile):
    points = vtk.vtkPoints()
    triangles = vtk.vtkCellArray()
    count = len(profile)
    for i in range(SEGMENTS):
        angle = i * 2 * math.pi / SEGMENTS
        for radius, z in profile:
            points.InsertNextPoint(SCALE * radius * math.cos(angle), SCALE * radius * math.sin(angle), SCALE * z)
    for i in range(SEGMENTS):
        for j in range(count):
            a = i * count + j
            b = ((i + 1) % SEGMENTS) * count + j
            c = ((i + 1) % SEGMENTS) * count + (j + 1) % count
            d = i * count + (j + 1) % count
            triangles.InsertNextCell(3, [a, b, c])
            triangles.InsertNextCell(3, [a, c, d])
    mesh = vtk.vtkPolyData()
    mesh.SetPoints(points)
    mesh.SetPolys(triangles)
    return normals(mesh)


def race(inner):
    groove_z = np.linspace(0.63, -0.63, 65)
    if inner:
        profile = [(2.08, 1), (2.95, 1), (3.03, 0.92), (3.03, 0.64)]
        profile += [(PITCH_RADIUS - math.sqrt(GROOVE_RADIUS ** 2 - z ** 2), float(z)) for z in groove_z]
        profile += [(3.03, -0.64), (3.03, -0.92), (2.95, -1), (2.08, -1), (2, -0.92), (2, 0.92)]
    else:
        profile = [(3.65, 1), (4.62, 1), (4.7, 0.92), (4.7, -0.92), (4.62, -1), (3.65, -1), (3.57, -0.92), (3.57, -0.64)]
        profile += [(PITCH_RADIUS + math.sqrt(GROOVE_RADIUS ** 2 - z ** 2), float(z)) for z in groove_z[::-1]]
        profile += [(3.57, 0.64), (3.57, 0.92)]
    return revolve(profile)


def balls():
    append = vtk.vtkAppendPolyData()
    for i in range(BALL_COUNT):
        angle = i * 2 * math.pi / BALL_COUNT
        sphere = vtk.vtkSphereSource()
        sphere.SetCenter(SCALE * PITCH_RADIUS * math.cos(angle), SCALE * PITCH_RADIUS * math.sin(angle), 0)
        sphere.SetRadius(SCALE * BALL_RADIUS)
        sphere.SetThetaResolution(56)
        sphere.SetPhiResolution(40)
        sphere.Update()
        append.AddInputData(sphere.GetOutput())
    append.Update()
    return normals(append.GetOutput())


def cage():
    extent = (-3.62, 3.62, -3.62, 3.62, -0.92, 0.92)
    dimensions = (193, 193, 69)
    x = np.linspace(extent[0], extent[1], dimensions[0], dtype=np.float32)
    y = np.linspace(extent[2], extent[3], dimensions[1], dtype=np.float32)
    z = np.linspace(extent[4], extent[5], dimensions[2], dtype=np.float32)[:, None, None]
    xx, yy = np.meshgrid(x, y)
    radius = np.sqrt(xx * xx + yy * yy)[None, :, :]
    field = np.maximum(np.abs(z) - 0.83, np.maximum(radius - 3.51, 3.09 - radius))
    for i in range(BALL_COUNT):
        angle = i * 2 * math.pi / BALL_COUNT
        dx = xx - PITCH_RADIUS * math.cos(angle)
        dy = yy - PITCH_RADIUS * math.sin(angle)
        pocket = np.sqrt(dx[None, :, :] ** 2 + dy[None, :, :] ** 2 + z * z) - 0.73
        field = np.maximum(field, -pocket)
    image = vtk.vtkImageData()
    image.SetDimensions(*dimensions)
    image.SetOrigin(SCALE * extent[0], SCALE * extent[2], SCALE * extent[4])
    image.SetSpacing(*[SCALE * (extent[2 * axis + 1] - extent[2 * axis]) / (dimensions[axis] - 1) for axis in range(3)])
    image.GetPointData().SetScalars(numpy_to_vtk(field.astype(np.float32).ravel(), deep=True))
    contour = vtk.vtkFlyingEdges3D()
    contour.SetInputData(image)
    contour.SetValue(0, 0)
    contour.ComputeNormalsOff()
    contour.Update()
    return normals(contour.GetOutput())


def save(name, mesh, output, color, opacity, label):
    edges = vtk.vtkFeatureEdges()
    edges.SetInputData(mesh)
    edges.BoundaryEdgesOn()
    edges.NonManifoldEdgesOn()
    edges.FeatureEdgesOff()
    edges.ManifoldEdgesOff()
    edges.Update()
    if edges.GetOutput().GetNumberOfCells():
        raise RuntimeError(f"The {name} surface is not closed and manifold")
    path = output / f"{name}.vtp"
    writer = vtk.vtkXMLPolyDataWriter()
    writer.SetInputData(mesh)
    writer.SetFileName(str(path))
    writer.SetDataModeToBinary()
    writer.SetCompressorTypeToZLib()
    writer.SetHeaderTypeToUInt32()
    writer.SetIdTypeToInt32()
    if not writer.Write():
        raise RuntimeError(f"Could not write {path}")
    return {
        "url": f"/Data/deep-transparency/cad/{path.name}",
        "color": color,
        "opacity": opacity,
        "label": label,
        "pointCount": mesh.GetNumberOfPoints(),
        "triangleCount": mesh.GetNumberOfPolys(),
        "bounds": list(mesh.GetBounds()),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "bytes": path.stat().st_size,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    actors = [
        save("outer-race", race(False), args.output, [0.22, 0.72, 0.83], 0.24, "Outer race"),
        save("inner-race", race(True), args.output, [0.78, 0.84, 0.91], 0.72, "Inner race"),
        save("rolling-balls", balls(), args.output, [1, 0.64, 0.25], 0.96, "Rolling balls"),
        save("retainer", cage(), args.output, [0.64, 0.48, 0.88], 0.7, "Retainer cage"),
    ]
    scene = {
        "name": "Bearing assembly",
        "description": "A parametric mechanical assembly: twelve rolling balls fit between grooved inner and outer races, held apart by a pocketed retainer cage.",
        "note": "The transparent outer race reveals the ball-to-race fit and the retainer pockets. Orbit to follow the clearances through the assembly.",
        "credit": "Original parametric ball-bearing assembly created for this demo.",
        "attributionNote": "Dimensions illustrate component fit and are not a manufacturing specification.",
        "geometryKind": "Parametric CAD assembly",
        "generator": "prepare-cad.py",
        "units": "millimetres",
        "dimensions": {"outsideDiameter": 94, "boreDiameter": 40, "width": 20, "pitchDiameter": 66, "ballDiameter": 13.6, "ballCount": BALL_COUNT, "radialGrooveClearance": 0.07, "cagePocketDiameter": 14.6},
        "actors": actors,
        "triangleCount": sum(actor["triangleCount"] for actor in actors),
        "viewDirection": [1.1, -1.8, 1.8],
        "viewUp": [0, 0, 1],
        "background": [0.055, 0.075, 0.105],
    }
    (args.output / "manifest.json").write_text(json.dumps({"scenes": {"cad": scene}}, indent=2) + "\n")
    print(f"Prepared {scene['triangleCount']:,} triangles in four fitted components")


if __name__ == "__main__":
    main()
