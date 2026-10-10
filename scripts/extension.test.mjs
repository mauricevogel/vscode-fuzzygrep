import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: [join(root, 'src/extension.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false, logLevel: 'silent' });
const disposable = () => ({ dispose() {} });
const uri = (path) => ({ fsPath: path, path, toString: () => path });

test('shortcut opens hidden views, refocuses visible unfocused views, and hides focused views without clearing the query', async () => {
  const commands = new Map();
  const executed = [];
  const posted = [];
  let receive;
  let visibility;
  let disposeView;
  let provider;
  const view = {
    visible: false,
    webview: {
      cspSource: 'vscode-webview:',
      asWebviewUri: (value) => value.toString(),
      postMessage: (message) => { posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (callback) => { receive = callback; return disposable(); }
    },
    onDidChangeVisibility: (callback) => { visibility = callback; return disposable(); },
    onDidDispose: (callback) => { disposeView = callback; return disposable(); }
  };
  const mock = {
    Uri: { joinPath: (base, ...paths) => uri(join(base.fsPath, ...paths)) },
    extensions: { all: [], onDidChange: disposable },
    workspace: { onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable },
    window: { registerWebviewViewProvider: (_id, value) => { provider = value; return disposable(); }, showErrorMessage: (message) => assert.fail(message) },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); },
      executeCommand: async (id) => {
        executed.push(id);
        view.visible = id !== 'workbench.action.closePanel';
        visibility();
      }
    }
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)((id) => id === 'vscode' ? mock : require(id), module, module.exports);
  const context = { extensionUri: uri(root), subscriptions: [] };
  module.exports.activate(context);
  provider.resolveWebviewView(view);
  const toggle = commands.get('fuzzygrep.toggle');
  const send = async (message) => { receive(message); await new Promise(setImmediate); };
  const checkCommand = async (expected) => { executed.length = 0; await toggle(); assert.deepEqual(executed, [expected]); };
  try {
    await checkCommand('fuzzygrep.search.focus');
    assert.equal(posted.at(-1).type, 'focus');
    await send({ type: 'search', query: 'needle', revision: 1 });
    await send({ type: 'focusChanged', focused: true });
    await checkCommand('workbench.action.closePanel');
    await checkCommand('fuzzygrep.search.focus');
    await send({ type: 'ready' });
    assert.equal(posted.findLast((message) => message.type === 'state').state.query, 'needle');
    await send({ type: 'focusChanged', focused: true });
    await send({ type: 'focusChanged', focused: false });
    await checkCommand('fuzzygrep.search.focus');
    assert.equal(view.visible, true);
    assert.equal(posted.at(-1).type, 'focus');
    await send({ type: 'focusChanged', focused: true });
    await checkCommand('workbench.action.closePanel');
    // A shortcut captured inside the webview proves focus even before a focus message arrives.
    await checkCommand('fuzzygrep.search.focus');
    executed.length = 0;
    await send({ type: 'toggle' });
    assert.deepEqual(executed, ['workbench.action.closePanel']);
    // External hiding/disposal must discard prior focus state.
    await checkCommand('fuzzygrep.search.focus');
    await send({ type: 'focusChanged', focused: true });
    view.visible = false;
    visibility();
    await checkCommand('fuzzygrep.search.focus');
    await send({ type: 'escape' });
    assert.equal(posted.findLast((message) => message.type === 'state').state.query, '');
    disposeView();
    await checkCommand('fuzzygrep.search.focus');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
  }
});

test('overlapping roots deduplicate by path and line before batching and the result limit, and reset per search', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const children = [];
  const posted = [];
  let provider;
  const mock = {
    Uri: {
      joinPath: (base, ...paths) => uri(join(base.fsPath, ...paths)),
      file: uri
    },
    extensions: { all: [], onDidChange: disposable },
    workspace: {
      workspaceFolders: [
        { uri: { ...uri(root), scheme: 'file' }, name: 'workspace' },
        { uri: { ...uri(join(root, 'src')), scheme: 'file' }, name: 'src' }
      ],
      onDidChangeWorkspaceFolders: disposable, onDidChangeConfiguration: disposable,
      fs: { stat: async () => ({ size: 6 * 1024 * 1024 }) }
    },
    window: { registerWebviewViewProvider: (_id, value) => { provider = value; return disposable(); } },
    commands: { registerCommand: disposable }
  };
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    children.push(child);
    return child;
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', compiled.outputFiles[0].text)(
    (id) => id === 'vscode' ? mock : id === 'node:child_process' ? { spawn } : require(id),
    module, module.exports, { ...process, platform: 'darwin', arch: 'arm64' }
  );
  const context = { extensionUri: uri(root), subscriptions: [] };
  module.exports.activate(context);
  provider.view = { webview: { postMessage: (message) => { posted.push(message); } } };
  const emit = (child, path, line) => child.stdout.write(JSON.stringify({
    type: 'match', data: {
      path: { text: path }, lines: { text: 'needle\n' }, line_number: line,
      submatches: [{ start: 0, end: 6 }]
    }
  }) + '\n');
  try {
    provider.startSearch('needle', 1);
    t.mock.timers.tick(150);
    assert.equal(children.length, 2);
    emit(children[0], './src/shared.txt', 1);
    emit(children[1], './shared.txt', 1);
    emit(children[1], './shared.txt', 2);
    emit(children[0], './other.txt', 1);
    t.mock.timers.tick(50);
    assert.equal(provider.state.results.length, 3, 'distinct lines and paths must remain');
    assert.equal(posted.filter((message) => message.type === 'results').flatMap((message) => message.matches).length, 3);

    // Duplicate lines must not consume the limit, including after a batch flush.
    for (let line = 3; line <= 4997; line++) emit(children[0], './src/shared.txt', line);
    for (let line = 1; line <= 4997; line++) emit(children[1], './shared.txt', line);
    assert.equal(provider.state.results.length, 4998);
    assert.equal(provider.state.searching, true);
    assert.equal(provider.state.truncated, false);
    emit(children[1], './shared.txt', 4998);
    emit(children[1], './shared.txt', 4999);
    assert.equal(provider.state.results.length, 5000);
    assert.equal(provider.state.truncated, true);
    assert(children.every((child) => child.killed));
    assert.equal(posted.filter((message) => message.type === 'results').flatMap((message) => message.matches).length, 5000);

    provider.startSearch('needle', 2);
    t.mock.timers.tick(150);
    emit(children[2], './src/shared.txt', 1);
    emit(children[3], './shared.txt', 1);
    assert.equal(provider.state.results.length, 1, 'deduplication must reset for each query');
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
  }
});
