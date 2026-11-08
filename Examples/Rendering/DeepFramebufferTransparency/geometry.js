import { vec3 } from 'gl-matrix';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import vtkPolyDataNormals from '@kitware/vtk.js/Filters/Core/PolyDataNormals';
import vtkSphereSource from '@kitware/vtk.js/Filters/Sources/SphereSource';
import vtkTorusSource from '@kitware/vtk.js/Filters/Sources/TorusSource';
import vtkPlaneSource from '@kitware/vtk.js/Filters/Sources/PlaneSource';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';

const TAU = Math.PI * 2;

export const makeActor = (data, color, opacity = 1) => {
  const mapper = vtkMapper.newInstance({ scalarVisibility: false });
  mapper.setInputData(data);
  const actor = vtkActor.newInstance();
  actor.setMapper(mapper);
  actor.getProperty().set({
    color,
    opacity,
    alphaMode: 2,
    ambient: 0.2,
    diffuse: 0.8,
    specular: 0.3,
    specularPower: 35,
    metallic: 0.08,
    roughness: 0.38,
  });
  actor.getProperty().setInterpolationToPBR();
  return actor;
};

const trefoilCenter = (t) => [
  0.46 * (Math.sin(t) + 2 * Math.sin(2 * t)),
  0.46 * (Math.cos(t) - 2 * Math.cos(2 * t)),
  -0.46 * Math.sin(3 * t),
];

const makeTrefoil = () => {
  const segments = 256;
  const sides = 24;
  const points = new Float32Array((segments + 1) * (sides + 1) * 3);
  const normals = new Float32Array(points.length);
  const polys = new Uint32Array(segments * sides * 8);
  const tangent = [];
  const normal = [];
  const binormal = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * TAU;
    const center = trefoilCenter(t);
    vec3.subtract(tangent, trefoilCenter(t + 0.001), trefoilCenter(t - 0.001));
    vec3.normalize(tangent, tangent);
    vec3.cross(normal, tangent, [0, 0, 1]);
    vec3.normalize(normal, normal);
    vec3.cross(binormal, tangent, normal);
    for (let j = 0; j <= sides; j++) {
      const angle = (j / sides) * TAU;
      const offset = (i * (sides + 1) + j) * 3;
      for (let k = 0; k < 3; k++) {
        const n = Math.cos(angle) * normal[k] + Math.sin(angle) * binormal[k];
        normals[offset + k] = n;
        points[offset + k] = center[k] + 0.15 * n;
      }
    }
  }
  let offset = 0;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      polys.set([3, a, a + 1, b, 3, a + 1, b + 1, b], offset);
      offset += 8;
    }
  }
  const data = vtkPolyData.newInstance();
  data.getPoints().setData(points, 3);
  data.getPolys().setData(polys);
  data.getPointData().setNormals(
    vtkDataArray.newInstance({
      name: 'Normals',
      numberOfComponents: 3,
      values: normals,
    })
  );
  return data;
};

const makeShell = () => {
  const source = vtkSphereSource.newInstance({
    radius: 1.85,
    thetaResolution: 112,
    phiResolution: 80,
  });
  const actor = makeActor(source.getOutputData(), [0.12, 0.75, 0.73], 0.2);
  actor.setScale(1, 0.93, 0.84);
  return actor;
};

const makeTorus = (color, orientation, position) => {
  const source = vtkTorusSource.newInstance({
    radius: 1.1,
    tubeRadius: 0.35,
    resolution: 128,
    tubeResolution: 40,
  });
  const normals = vtkPolyDataNormals.newInstance();
  normals.setInputConnection(source.getOutputPort());
  const actor = makeActor(normals.getOutputData(), color, 0.42);
  actor.setOrientation(...orientation);
  actor.setPosition(...position);
  return actor;
};

const makeRectangle = (origin, point1, point2, color) => {
  const source = vtkPlaneSource.newInstance({
    origin,
    point1,
    point2,
    xResolution: 1,
    yResolution: 1,
  });
  const actor = makeActor(source.getOutputData(), color, 0.5);
  actor.getProperty().setInterpolationToPhong();
  actor.getProperty().setLighting(false);
  return actor;
};

export const createScenes = () => ({
  nested: {
    name: 'Nested structures',
    description:
      'A transparent enclosure reveals a folded inner surface. Orbit to follow which parts pass in front.',
    note: 'The front of the shell attenuates the knot. Its rear surface stays behind it.',
    legend: [
      ['#1fbfba', 'Outer shell'],
      ['#ffb064', 'Inner surface'],
    ],
    actors: [makeShell(), makeActor(makeTrefoil(), [1, 0.54, 0.22], 0.85)],
    defaultOpacity: 0.2,
    controlledActors: [0],
    position: [4, 2.2, 5.7],
    parallelScale: 2.3,
    background: [0.025, 0.04, 0.06],
  },
  intersecting: {
    name: 'Intersecting fields',
    description:
      'Three translucent surfaces cross through one another. Their order changes across the same triangle.',
    note: 'Each pixel gets its own depth ordering, including the back surfaces of each ring.',
    legend: [
      ['#24c5bf', 'Field A'],
      ['#ffb264', 'Field B'],
      ['#ac8cff', 'Field C'],
    ],
    actors: [
      makeTorus([0.14, 0.77, 0.75], [22, 0, 0], [0, 0, 0]),
      makeTorus([1, 0.65, 0.3], [82, 32, 16], [0.2, 0, 0]),
      makeTorus([0.67, 0.51, 0.98], [28, 78, -18], [-0.2, 0, 0]),
    ],
    defaultOpacity: 0.42,
    controlledActors: [0, 1, 2],
    position: [4, 2.5, 6],
    parallelScale: 2.1,
    background: [0.025, 0.04, 0.06],
  },
  layers: {
    name: 'Two-layer proof',
    description:
      'Unlit red and blue rectangles over black. Swap their depths without changing their draw order.',
    note: 'At 50% opacity, red in front gives RGB (128, 0, 64); blue in front gives (64, 0, 128).',
    legend: [
      ['#ff5252', 'Red rectangle'],
      ['#5476ff', 'Blue rectangle'],
    ],
    actors: [
      makeRectangle(
        [-1.35, -0.55, 0.2],
        [0.65, -0.55, 0.2],
        [-1.35, 1.05, 0.2],
        [1, 0, 0]
      ),
      makeRectangle(
        [-0.65, -1.05, -0.2],
        [1.35, -1.05, -0.2],
        [-0.65, 0.55, -0.2],
        [0, 0, 1]
      ),
    ],
    defaultOpacity: 0.5,
    controlledActors: [0, 1],
    position: [0, 0, 6],
    parallelScale: 1.75,
    background: [0, 0, 0],
  },
});
