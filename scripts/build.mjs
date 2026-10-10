import { build, context } from 'esbuild';
import { createRequire } from 'node:module';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const ripgrep = await import('@vscode/ripgrep');
const rgPath = ripgrep.rgPath ?? ripgrep.default?.rgPath;
if (!rgPath) throw new Error('The installed @vscode/ripgrep package did not provide a binary path.');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Fuzzygrep v1 must be built on macOS arm64 so its bundled ripgrep matches the VSIX target.');
}
await mkdir(join(root, 'dist/bin'), { recursive: true });
await copyFile(rgPath, join(root, 'dist/bin/rg'));
await chmod(join(root, 'dist/bin/rg'), 0o755);
await copyFile(join(root, 'media/search.css'), join(root, 'dist/search.css'));
await copyFile(join(root, 'vendor/vscode-oniguruma/onig.wasm'), join(root, 'dist/onig.wasm'));
await copyFile(join(root, 'node_modules/jsonc-parser/LICENSE.md'), join(root, 'dist/LICENSE.jsonc-parser.txt'));
for (const [source, target] of [
  ['vscode-textmate/LICENSE.txt', 'LICENSE.textmate.txt'],
  ['vscode-oniguruma/LICENSE.txt', 'LICENSE.oniguruma.txt'],
  ['vscode-oniguruma/NOTICES.txt', 'NOTICES.oniguruma.txt']
]) await copyFile(join(root, 'vendor', source), join(root, 'dist', target));

// Keep the upstream license alongside the binary in the installed extension.
// Resolve the public entry point; newer releases do not export package.json.
const packageRoot = dirname(dirname(require.resolve('@vscode/ripgrep')));
let license;
for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
  try { license = await readFile(join(packageRoot, name), 'utf8'); break; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
if (!license) throw new Error('Could not find the bundled ripgrep package license.');
await writeFile(join(root, 'dist/bin/LICENSE.ripgrep-wrapper.txt'), license);

const options = [
  { entryPoints: [join(root, 'src/extension.ts')], outfile: join(root, 'dist/extension.js'), platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true },
  { entryPoints: [join(root, 'src/webview.ts')], outfile: join(root, 'dist/webview.js'), platform: 'browser', format: 'iife', target: 'es2022' }
].map((option) => ({ ...option, bundle: true, logLevel: 'info' }));

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all(options.map((option) => context(option)));
  await Promise.all(contexts.map((builder) => builder.watch()));
  console.log('Watching TypeScript. Re-run build after changing CSS.');
} else {
  await Promise.all(options.map((option) => build(option)));
}
