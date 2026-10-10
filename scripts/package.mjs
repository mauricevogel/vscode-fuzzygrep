import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDependencies } from './dependencies.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const vsixPath = join(root, 'dist/fuzzygrep.vsix');

export async function packageExtension() {
  await ensureDependencies(root);
  await mkdir(join(root, 'dist'), { recursive: true });
  const require = createRequire(import.meta.url);
  const manifest = require('@vscode/vsce/package.json');
  const cli = join(require.resolve('@vscode/vsce/package.json'), '..', manifest.bin.vsce);
  const result = spawnSync(process.execPath, [cli, 'package', '--no-dependencies', '--target', 'darwin-arm64', '--out', vsixPath, '--allow-missing-repository'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packaging failed (exit ${result.status ?? result.signal}).`);
  return vsixPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageExtension().catch((error) => {
    console.error(`Fuzzygrep: ${error.message}`);
    process.exitCode = 1;
  });
}
