#!/usr/bin/env python3
"Generate deterministic shared opaque meshes and scene specifications."

import argparse
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_vtp(path, points, normals, triangles):
    def values(rows):
        return " ".join(format(v, ".9g") for row in rows for v in row)
    path.write_text(f'''<?xml version="1.0"?>
<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
<PolyData><Piece NumberOfPoints="{len(points)}" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="{len(triangles)}">
<PointData Normals="Normals"><DataArray type="Float32" Name="Normals" NumberOfComponents="3" format="ascii">{values(normals)}</DataArray></PointData><CellData/>
<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">{values(points)}</DataArray></Points>
<Polys><DataArray type="Int32" Name="connectivity" format="ascii">{values(triangles)}</DataArray><DataArray type="Int32" Name="offsets" format="ascii">{" ".join(str(3*(i+1)) for i in range(len(triangles)))}</DataArray></Polys>
</Piece></PolyData></VTKFile>
''')
    return {"path": str(path), "url": "/@fs/" + str(path), "sha256": digest(path), "pointCount": len(points), "triangleCount": len(triangles), "color": [.18, .36, .54], "opacity": 1}


def make_meshes(directory):
    directory.mkdir(parents=True, exist_ok=True)
    plane_points = [(-.8, -.8, 0), (.8, -.8, 0), (.8, .8, 0), (-.8, .8, 0)]
    plane = write_vtp(directory / "plane.vtp", plane_points, [(0, 0, 1)] * 4, [(0, 1, 2), (0, 2, 3)])
    n_theta, n_phi = 128, 64
    normals = [(0, 0, 1)]
    for j in range(1, n_phi):
        phi = math.pi * j / n_phi
        normals.extend((math.sin(phi)*math.cos(2*math.pi*i/n_theta), math.sin(phi)*math.sin(2*math.pi*i/n_theta), math.cos(phi)) for i in range(n_theta))
    normals.append((0, 0, -1))
    triangles = []
    def ring(j, i):
        return 1 + j*n_theta + i % n_theta
    for i in range(n_theta):
        triangles.append((0, ring(0, i), ring(0, i+1)))
    for j in range(n_phi-2):
        for i in range(n_theta):
            a, b, c, d = ring(j, i), ring(j+1, i), ring(j+1, i+1), ring(j, i+1)
            triangles.extend([(a,b,c), (a,c,d)])
    for i in range(n_theta):
        triangles.append((ring(n_phi-2, i), len(normals)-1, ring(n_phi-2, i+1)))
    points = [tuple(.7*v for v in normal) for normal in normals]
    sphere = write_vtp(directory / "sphere.vtp", points, normals, triangles)
    return plane, sphere


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "Utilities/TestResults/pbr-isolation/specs")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    plane, sphere = make_meshes(output / "meshes")
    baseline = {"width":256,"height":256,"background":[0,0,0],"backgroundAlpha":1,"multiSample":1,"mode":"pbr","deepFramebuffer":False,"poolLayers":1,
      "camera":{"position":[0,0,4],"focalPoint":[0,0,0],"viewUp":[0,1,0],"parallelProjection":False,"parallelScale":1.5,"viewAngle":30,"clippingRange":[.1,10]},
      "material":{"ambient":0,"diffuse":.8,"specular":.5,"specularPower":30,"metallic":0,"roughness":.5,"baseIOR":1.5},
      "lights":[{"position":[1,0,3],"focalPoint":[0,0,0],"color":[1,1,1],"intensity":.6,"positional":False}],"actors":[plane]}
    cases = []
    def emit(name, mesh=plane, material=None, lights=None, mode="pbr", parallel=False):
        scene = deepcopy(baseline)
        scene["name"] = name
        scene["actors"] = [deepcopy(mesh)]
        scene["mode"] = mode
        scene["camera"]["parallelProjection"] = parallel
        if material: scene["material"].update(material)
        if lights is not None: scene["lights"] = lights
        if mode == "unlit": scene["material"].update(ambient=1,diffuse=0,specular=0)
        path = output / (name + ".json")
        path.write_text(json.dumps(scene, indent=2) + "\n")
        cases.append({"name":name,"path":str(path),"url":"/@fs/"+str(path)})
    for suffix, value in [("0",0),("025",.25),("05",.5),("1",1)]: emit("plane-diffuse-"+suffix,material={"diffuse":value})
    for suffix, value in [("0",0),("01",.1),("05",.5)]: emit("plane-ambient-"+suffix,material={"ambient":value,"diffuse":0},lights=[{"position":[1,0,3],"focalPoint":[0,0,0],"color":[0,0,0],"intensity":.6,"positional":False}])
    emit("plane-unlit",mode="unlit")
    emit("sphere-base",mesh=sphere)
    emit("sphere-ortho",mesh=sphere,parallel=True)
    emit("sphere-metallic-05",mesh=sphere,material={"metallic":.5})
    for suffix,value in [("01",.1),("09",.9)]: emit("sphere-roughness-"+suffix,mesh=sphere,material={"roughness":value})
    for suffix,value in [("01",.1),("05",.5),("09",.9)]: emit("sphere-metallic-roughness-"+suffix,mesh=sphere,material={"metallic":1,"roughness":value})
    for suffix,value in [("1",1),("15",1.5),("2",2)]: emit("plane-ior-"+suffix,material={"baseIOR":value})
    for suffix, value in [("0",0),("01",.1),("05",.5)]:
        emit("plane-ambient-diffuse1-"+suffix,material={"ambient":value,"diffuse":1},lights=[{"position":[1,0,3],"focalPoint":[0,0,0],"color":[0,0,0],"intensity":.6,"positional":False}])
    (output / "index.json").write_text(json.dumps({"cases":cases},indent=2)+"\n")
    print(f"Generated {len(cases)} opaque scenes in {output}")


if __name__ == "__main__":
    main()
