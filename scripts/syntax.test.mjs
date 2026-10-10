import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const uri = (path) => ({ fsPath: path, path, toString: () => path });
const grammar = JSON.stringify({
  scopeName: 'source.preview-test',
  patterns: [
    { name: 'comment.block', begin: '/\\*', end: '\\*/' },
    { name: 'string.quoted', begin: '"', end: '"' },
    { name: 'storage.type', match: '\\bconst\\b' },
    { name: 'constant.numeric', match: '\\b[0-9]+\\b' }
  ]
});
const themeRules = [
  { scope: 'comment', settings: { foreground: '#123456', fontStyle: 'italic' } },
  { scope: 'string', settings: { foreground: '#234567' } },
  { scope: 'storage', settings: { foreground: '#345678' } },
  { scope: 'constant.numeric', settings: { foreground: '#456789' } }
];
const fixtures = new Map([
  ['fixture.json', grammar],
  ['theme.json', JSON.stringify({ tokenColors: themeRules })],
  ['other-theme.json', JSON.stringify({ tokenColors: [
    { scope: 'comment', settings: { foreground: '#ABCDEF', fontStyle: 'bold underline strikethrough' } }
  ] })],
  ['parent.json', `{// A JSONC theme with a trailing comma\n "tokenColors": ${JSON.stringify(themeRules)},}`],
  ['child.json', JSON.stringify({ include: 'parent.json', tokenColors: [
    { scope: 'source.preview-test string.quoted', settings: { foreground: '#FEDCBA', fontStyle: 'bold' } }
  ] })],
  ['legacy.tmTheme', `<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array><dict><key>scope</key><string>storage</string><key>settings</key><dict><key>foreground</key><string>#DDAABB</string></dict></dict></array></dict></plist>`],
  ['legacy.json', JSON.stringify({ tokenColors: 'legacy.tmTheme' })],
  ['cycle.json', JSON.stringify({ include: 'cycle.json' })]
]);
const contributions = fixtures.keys();
const themes = [...contributions].filter((path) => path !== 'fixture.json').map((path) => ({ id: path, path }));
let customizations = {};
const mock = {
  Uri: { joinPath: (base, ...paths) => uri(join(base.fsPath, ...paths)) },
  extensions: {
    all: [{ extensionUri: uri(root), packageJSON: { contributes: { grammars: [
      { language: 'preview-test', scopeName: 'source.preview-test', path: 'fixture.json' },
      { language: 'broken', scopeName: 'source.broken', path: 'broken.json' }
    ], themes } } }],
    onDidChange: () => ({ dispose() {} })
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => key === 'workbench.colorTheme' ? 'theme.json' : key === 'editor.tokenColorCustomizations' ? customizations : fallback }),
    fs: { readFile: async (path) => Buffer.from(fixtures.get(path.path.split('/').at(-1)) ?? '{bad JSON') }
  },
  window: { activeColorTheme: { kind: 2 } },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 }
};
const compiled = await build({ entryPoints: [join(root, 'src/syntax.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  (id) => id === 'vscode' ? mock : require(id), module, module.exports
);
const { PreviewHighlighter } = module.exports;
// Exercise the runtime copied by the build, which is the file shipped in the VSIX.
await readFile(join(root, 'dist/onig.wasm'));

test('preview keeps multiline context, token offsets, and invalidates changed documents', async () => {
  const highlighter = new PreviewHighlighter(uri(root));
  let source = ['/* comment begins above visible context', ...Array(12).fill('still a comment'), '*/ const value = "😀<&>";', 'const answer = 42;'];
  let reads = 0;
  const document = {
    languageId: 'preview-test', version: 1,
    lineAt: (line) => { reads++; return { text: source[line] }; }
  };
  const preview = (start, end) => source.slice(start, end + 1).map((text, index) => ({ line: start + index, text, ranges: [] }));
  try {
    const lines = preview(10, 14);
    await highlighter.highlight(document, lines);
    assert.equal(lines[0].tokens[0].color, '#123456');
    assert.equal(lines[0].tokens[0].fontStyle, 1);
    assert(lines[3].tokens.some((token) => token.color === '#345678'));
    assert(lines[3].tokens.some((token) => token.color === '#234567' && lines[3].text.slice(token.start, token.end).includes('😀<&>')));
    assert(lines[4].tokens.some((token) => token.color === '#456789'));
    for (const line of lines) {
      assert.equal(line.tokens.map((token) => line.text.slice(token.start, token.end)).join(''), line.text);
      assert(line.tokens.every((token) => token.end <= line.text.length));
    }
    const priorReads = reads;
    await highlighter.highlight(document, preview(11, 14));
    assert.equal(reads, priorReads, 'navigation should reuse tokenized context');
    source = source.map(() => 'const value = 42;');
    document.version++;
    const changed = preview(10, 14);
    await highlighter.highlight(document, changed);
    assert.equal(changed[0].tokens[0].color, '#345678');
    assert(changed[0].tokens.every((token) => token.color !== '#123456'));
  } finally { highlighter.dispose(); }
});

test('active themes, inherited JSONC rules, scoped selectors, and legacy themes supply colors and font styles', async () => {
  const highlighter = new PreviewHighlighter(uri(root));
  const source = ['/* begins above preview', 'comment */ const value = "hello";'];
  const document = { languageId: 'preview-test', version: 1, lineAt: (line) => ({ text: source[line] }) };
  const appearance = (id) => ({ id, foreground: '#112233', background: '#FFFFFF' });
  const preview = () => [{ line: 1, text: source[1], ranges: [] }];
  try {
    assert.equal(highlighter.setTheme(appearance('theme.json')), true);
    let lines = preview();
    await highlighter.highlight(document, lines);
    assert.equal(lines[0].tokens[0].color, '#123456');
    highlighter.setTheme(appearance('other-theme.json'));
    lines = preview();
    await highlighter.highlight(document, lines);
    assert.equal(lines[0].tokens[0].color, '#ABCDEF', 'cached multiline context must be rethemed');
    assert.equal(lines[0].tokens[0].fontStyle, 14);
    assert(lines[0].tokens.some((token) => token.color === '#112233'), 'unstyled tokens use the actual editor foreground');
    assert.equal(highlighter.setTheme(appearance('other-theme.json')), false);
    highlighter.setTheme(appearance('child.json'));
    lines = preview();
    await highlighter.highlight(document, lines);
    assert.equal(lines[0].tokens[0].color, '#123456');
    assert(lines[0].tokens.some((token) => token.color === '#FEDCBA' && token.fontStyle === 2));
    highlighter.setTheme(appearance('legacy.json'));
    lines = preview();
    await highlighter.highlight(document, lines);
    assert(lines[0].tokens.some((token) => token.color === '#DDAABB'));
  } finally { highlighter.dispose(); }
});

test('global and theme-scoped user customizations override theme rules and refresh cached previews', async () => {
  const highlighter = new PreviewHighlighter(uri(root));
  const document = { languageId: 'preview-test', version: 1, lineAt: () => ({ text: 'const value = "hello";' }) };
  const preview = () => [{ line: 0, text: document.lineAt(0).text, ranges: [] }];
  try {
    highlighter.setTheme({ id: 'child.json', foreground: '#112233', background: '#FFFFFF' });
    customizations = {
      keywords: '#665544',
      '[unselected]': { strings: '#000000' },
      '[child*][other]': { textMateRules: [{ scope: 'source.preview-test string.quoted', settings: { foreground: '#BBAACC' } }] },
      '[child.json]': { textMateRules: [{ scope: 'storage', settings: { foreground: '#AABBCC' } }] }
    };
    let lines = preview();
    await highlighter.highlight(document, lines);
    assert.equal(lines[0].tokens[0].color, '#AABBCC');
    assert(lines[0].tokens.some((token) => token.color === '#BBAACC'));
    customizations = { keywords: '#665544' };
    highlighter.refreshTheme();
    lines = preview();
    await highlighter.highlight(document, lines);
    assert.equal(lines[0].tokens[0].color, '#665544');
  } finally { customizations = {}; highlighter.dispose(); }
});

test('missing, malformed, and circular themes preserve readable previews', async () => {
  const highlighter = new PreviewHighlighter(uri(root));
  try {
    for (const id of ['missing', 'broken.json', 'cycle.json']) {
      highlighter.setTheme({ id, foreground: '#112233', background: '#FFFFFF' });
      const lines = [{ line: 0, text: 'const value = 42;', ranges: [{ start: 14, end: 16 }] }];
      await highlighter.highlight({ languageId: 'preview-test', version: 1, lineAt: () => ({ text: lines[0].text }) }, lines);
      assert(lines[0].tokens.length > 0);
      assert(lines[0].tokens.every((token) => token.color === '#112233'));
      assert.deepEqual(lines[0].ranges, [{ start: 14, end: 16 }]);
    }
  } finally { highlighter.dispose(); }
});

test('unknown languages and malformed grammars retain plain-text previews', async () => {
  const highlighter = new PreviewHighlighter(uri(root));
  try {
    for (const languageId of ['plaintext', 'broken']) {
      const lines = [{ line: 0, text: '<script>😀</script>', ranges: [{ start: 8, end: 10 }] }];
      await highlighter.highlight({ languageId, version: 1 }, lines);
      assert.equal(lines[0].tokens, undefined);
      assert.equal(lines[0].text, '<script>😀</script>');
      assert.deepEqual(lines[0].ranges, [{ start: 8, end: 10 }]);
    }
  } finally { highlighter.dispose(); }
});
