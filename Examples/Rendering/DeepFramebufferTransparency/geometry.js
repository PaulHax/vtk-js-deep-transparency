import vtkPolyDataNormals from '@kitware/vtk.js/Filters/Core/PolyDataNormals';
import vtkTorusSource from '@kitware/vtk.js/Filters/Sources/TorusSource';
import vtkPlaneSource from '@kitware/vtk.js/Filters/Sources/PlaneSource';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';

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
  intersecting: {
    name: 'Intersecting rings',
    description:
      'Three translucent rings intersect. Their front-to-back order varies across the image.',
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
