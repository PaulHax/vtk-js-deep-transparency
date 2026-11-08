import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import nodePolyfills from '@rolldown/plugin-node-polyfills';
import { build, preview } from 'vite';
import { createExampleConfig } from '../ExampleRunner/vite.example.config.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const siteRoot = fileURLToPath(new URL('./', import.meta.url));
const output = path.join(repoRoot, 'dist/demo');
const base = process.env.SITE_BASE_PATH || './';
const groups = ['scans', 'impact', 'anatomy', 'cad'];
const { values } = parseArgs({
  options: {
    preview: { type: 'boolean', default: false },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4173' },
  },
});

if (
  base !== './' &&
  (!base.startsWith('/') ||
    !base.endsWith('/') ||
    base.startsWith('//') ||
    /[?#]/.test(base))
) {
  throw new Error(
    'SITE_BASE_PATH must be ./ or a path beginning and ending with /.'
  );
}

const exampleConfig = createExampleConfig({
  repoRoot,
  entry: path.join(
    repoRoot,
    'Examples/Rendering/DeepFramebufferTransparency/index.js'
  ),
  name: 'Transparency gallery',
});
const config = {
  ...exampleConfig,
  root: siteRoot,
  publicDir: false,
  base,
  plugins: [
    { ...nodePolyfills(), enforce: 'pre' },
    ...exampleConfig.plugins.filter(
      ({ name }) =>
        !['vtk-example-runner-entry', 'vtk-serve-data'].includes(name)
    ),
  ],
  build: { outDir: output, emptyOutDir: true },
  preview: { host: values.host, port: Number(values.port), strictPort: true },
};

if (values.preview) {
  const server = await preview(config);
  server.printUrls();
} else {
  await build(config);
  let meshes = 0;
  let bytes = 0;
  const copied = new Set();
  for (const group of groups) {
    const directory = `Data/deep-transparency/${group}`;
    const manifestPath = `${directory}/manifest.json`;
    const manifestBytes = await readFile(path.join(repoRoot, manifestPath));
    const manifest = JSON.parse(manifestBytes);
    await mkdir(path.join(output, directory), { recursive: true });
    await writeFile(path.join(output, manifestPath), manifestBytes);
    for (const scene of Object.values(manifest.scenes)) {
      for (const actor of scene.actors) {
        if (
          !actor.url.startsWith(`/${directory}/`) ||
          !actor.url.endsWith('.vtp')
        ) {
          throw new Error(`Unexpected prepared mesh path: ${actor.url}`);
        }
        const relative = actor.url.slice(1);
        if (copied.has(relative)) continue;
        const mesh = await readFile(path.join(repoRoot, relative));
        if (createHash('sha256').update(mesh).digest('hex') !== actor.sha256) {
          throw new Error(`Prepared mesh checksum mismatch: ${relative}`);
        }
        await writeFile(path.join(output, relative), mesh);
        copied.add(relative);
        meshes++;
        bytes += mesh.length;
      }
    }
  }
  console.log(
    `Copied ${groups.length} manifests and ${meshes} verified meshes (${bytes.toLocaleString('en-US')} bytes).`
  );
  console.log(`Static demo: ${output}`);
}
