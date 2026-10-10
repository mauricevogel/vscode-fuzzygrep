import assert from 'node:assert/strict';
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
