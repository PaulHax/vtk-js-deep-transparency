import '@kitware/vtk.js/IO/Core/DataAccessHelper/HttpDataAccessHelper';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import { makeActor } from './geometry';

export const datasetChoices = [
  { key: 'bonsai', name: 'Bonsai', group: 'scans' },
  { key: 'engine', name: 'Engine', group: 'scans' },
  { key: 'teapot', name: 'Boston Teapot', group: 'scans' },
  { key: 'impact', name: 'Asteroid ocean impact', group: 'impact' },
  { key: 'anatomy', name: 'Sinus anatomy', group: 'anatomy' },
  { key: 'cad', name: 'Ball-bearing assembly', group: 'cad' },
];

const colorHex = (color) =>
  `#${color
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;

export function createDatasetLoader() {
  const manifests = new Map();
  const scenes = new Map();

  async function readManifest(group) {
    if (!manifests.has(group)) {
      const promise = fetch(`/Data/deep-transparency/${group}/manifest.json`)
        .then(async (response) => {
          if (!response.ok) throw new Error('Dataset manifest is unavailable');
          const manifest = await response.json();
          if (!manifest.scenes)
            throw new Error('Dataset manifest has no scenes');
          return manifest;
        })
        .catch((error) => {
          manifests.delete(group);
          throw error;
        });
      manifests.set(group, promise);
    }
    return manifests.get(group);
  }

  async function load(key, onProgress = () => {}) {
    const choice = datasetChoices.find((item) => item.key === key);
    if (!choice) throw new Error(`Unknown dataset: ${key}`);
    if (!scenes.has(key)) {
      const promise = (async () => {
        onProgress(`Opening ${choice.name}`);
        const manifest = await readManifest(choice.group);
        const specification = manifest.scenes[key];
        if (!specification?.actors?.length) {
          manifests.delete(choice.group);
          throw new Error(`${choice.name} has not been prepared locally`);
        }
        let completed = 0;
        const meshes = await Promise.all(
          specification.actors.map(async (layer) => {
            const response = await fetch(layer.url);
            if (!response.ok) throw new Error(`Could not load ${layer.label}`);
            const bytes = await response.arrayBuffer();
            const reader = vtkXMLPolyDataReader.newInstance();
            try {
              reader.parseAsArrayBuffer(bytes);
              const mesh = reader.getOutputData();
              if (!mesh?.getNumberOfPoints()) {
                throw new Error(`The ${layer.label} surface is empty`);
              }
              completed += 1;
              onProgress(
                `Loading ${choice.name}: ${completed} of ${specification.actors.length} surfaces`
              );
              return mesh;
            } finally {
              reader.delete();
            }
          })
        );
        const actors = meshes.map((mesh, index) => {
          const layer = specification.actors[index];
          return makeActor(mesh, layer.color, layer.opacity);
        });
        const bounds = [
          Infinity,
          -Infinity,
          Infinity,
          -Infinity,
          Infinity,
          -Infinity,
        ];
        actors.forEach((actor) => {
          const actorBounds = actor.getBounds();
          for (let axis = 0; axis < 3; axis++) {
            bounds[axis * 2] = Math.min(
              bounds[axis * 2],
              actorBounds[axis * 2]
            );
            bounds[axis * 2 + 1] = Math.max(
              bounds[axis * 2 + 1],
              actorBounds[axis * 2 + 1]
            );
          }
        });
        const boundsCenter = [0, 1, 2].map(
          (axis) => (bounds[axis * 2] + bounds[axis * 2 + 1]) / 2
        );
        const radius = Math.hypot(
          ...boundsCenter.map((value, axis) => bounds[axis * 2 + 1] - value)
        );
        const center = specification.cameraFocalPoint || boundsCenter;
        const direction = specification.viewDirection || [1, -1.4, 0.7];
        const triangles = meshes.reduce(
          (total, mesh) => total + mesh.getNumberOfPolys(),
          0
        );
        return {
          ...specification,
          actors,
          bounds,
          center,
          radius,
          triangles,
          dataset: true,
          sourceUrl:
            specification.sourcePage ||
            specification.sourceUrl ||
            manifest.sourceUrl,
          credit: specification.credit || manifest.credit,
          defaultOpacity: specification.actors[0].opacity,
          controlledActors: [0],
          legend: specification.actors.map((layer) => [
            colorHex(layer.color),
            layer.label,
          ]),
          position: direction.map(
            (value, axis) => center[axis] + value * radius * 3
          ),
          viewUp: specification.viewUp || [0, 0, 1],
          background: specification.background || [0.025, 0.04, 0.06],
          note:
            specification.note ||
            'Original scan or simulation data, contoured at the same thresholds as the VTK comparison. Nearer surfaces attenuate the surfaces behind them.',
        };
      })().catch((error) => {
        scenes.delete(key);
        throw error;
      });
      scenes.set(key, promise);
    }
    return scenes.get(key);
  }

  return { load };
}
