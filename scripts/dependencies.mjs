import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function ensureDependencies(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const missing = [];
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    try {
      await access(join(root, 'node_modules', name, 'package.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(name);
    }
  }
  if (!missing.length) return;

  console.log(`Installing missing build dependencies: ${missing.join(', ')}`);
  // npm sets npm_execpath when running a script. Resolve npm beside Node as a
  // fallback for invoking these scripts directly, including Node managed by nvm.
  const npmCli = process.env.npm_execpath
    ?? await realpath(join(dirname(process.execPath), 'npm')).catch(() => undefined);
  const args = ['install', '--include=dev', '--no-audit', '--no-fund'];
  const result = npmCli?.endsWith('.js')
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error('Could not install build dependencies. Run "npm install --include=dev", then retry the install command.', { cause: result.error });
  }
}
