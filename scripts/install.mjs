import { spawnSync } from 'node:child_process';
import { packageExtension, root } from './package.mjs';

async function main() {
  const [editor, ...args] = process.argv.slice(2);
  const executable = { vscode: 'code', cursor: 'cursor' }[editor];
  if (!executable) throw new Error('Specify vscode or cursor.');

  let profile;
  if (args.length === 1 && args[0].startsWith('--profile=')) {
    profile = args[0].slice('--profile='.length);
  } else if (args.length === 2 && args[0] === '--profile') {
    profile = args[1];
  } else if (args.length > 0) {
    throw new Error(`Usage: npm run install:${editor} -- [--profile "Profile Name"]`);
  }
  if (profile !== undefined && !profile.trim()) throw new Error('Profile name must not be empty.');

  const artifact = await packageExtension();
  const cliArgs = ['--install-extension', artifact, '--force'];
  if (profile !== undefined) cliArgs.push('--profile', profile);
  // Pass an argument array so profile names with spaces and shell characters stay intact.
  const result = spawnSync(executable, cliArgs, { cwd: root, stdio: 'inherit' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Cannot find '${executable}'. In ${editor === 'vscode' ? 'VS Code' : 'Cursor'}, run "Shell Command: Install '${executable}' command in PATH" from the Command Palette.`);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Installation failed (exit ${result.status ?? result.signal}).`);
}

await main().catch((error) => {
  console.error(`Fuzzygrep: ${error.message}`);
  process.exitCode = 1;
});
