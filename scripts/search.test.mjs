import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: [join(root, 'src/search.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
function load(spawn) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
    (id) => id === 'node:child_process' && spawn ? { spawn } : require(id), module, module.exports
  );
  return module.exports.RipgrepSearch;
}

function record(text = 'needle\n', path = './fixture.txt') {
  const start = Buffer.byteLength(text.slice(0, text.indexOf('needle')));
  return JSON.stringify({ type: 'match', data: {
    path: { text: path }, lines: { text }, line_number: 3,
    submatches: [{ start, end: start + 6 }]
  } });
}

function harness(onMatch) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; return true; };
  const matches = [];
  const completions = [];
  const Search = load(() => child);
  const search = new Search('rg', 'needle', [{ path: root, name: 'workspace' }], {
    match: (match) => { matches.push(match); onMatch?.(search); },
    done: (error) => completions.push(error)
  });
  const close = async (tail = '', code = 0) => {
    child.stdout.end(tail);
    await new Promise(setImmediate);
    child.emit('close', code, null);
  };
  return { child, matches, completions, search, close };
}

test('Unicode line and paragraph separators inside JSON text and paths stay intact', async () => {
  const run = harness();
  const text = 'prefix\u2028😀\u2029needle suffix\n';
  await run.close(record(text, './file\u2028with\u2029separators.txt') + '\n');
  assert.deepEqual(run.completions, [undefined]);
  assert.equal(run.matches.length, 1);
  assert.equal(run.matches[0].text, text.trimEnd());
  assert.equal(run.matches[0].path, join(root, 'file\u2028with\u2029separators.txt'));
  assert.equal(run.matches[0].line, 2);
  assert.deepEqual(run.matches[0].ranges, [{ start: 10, end: 16 }]);
});

test('long JSON records buffer across chunks, including split UTF-8 characters', async () => {
  const run = harness();
  const text = 'x'.repeat(70000) + '😀\u2028needle\u2029 suffix\n';
  const bytes = Buffer.from(record(text) + '\n' + record('second needle\n') + '\r\n');
  const emoji = bytes.indexOf(Buffer.from('😀'));
  for (const [start, end] of [[0, 6549], [6549, emoji + 1], [emoji + 1, emoji + 3], [emoji + 3, bytes.length]]) {
    run.child.stdout.write(bytes.subarray(start, end));
  }
  await run.close();
  assert.deepEqual(run.completions, [undefined]);
  assert.deepEqual(run.matches.map((match) => match.text), [text.trimEnd(), 'second needle']);
  assert.equal(run.matches[0].column, 70003);
});

test('cancelling during a batch discards subsequent records and an unfinished tail', async () => {
  const run = harness((search) => search.cancel());
  run.child.stdout.write(record() + '\n' + record('second needle\n') + '\n' + '{"type":"match","data":"unfinished');
  await run.close();
  assert.equal(run.matches.length, 1);
  assert.equal(run.child.killed, true);
  assert.deepEqual(run.completions, []);
});

test('a complete final JSON record without a newline is still processed', async () => {
  const run = harness();
  await run.close(record());
  assert.equal(run.matches.length, 1);
  assert.deepEqual(run.completions, [undefined]);
});

test('malformed output reports one error and stops the search', async () => {
  const run = harness();
  await run.close('{"type":"match","data":"unfinished');
  assert.equal(run.completions.length, 1);
  assert.match(run.completions[0], /^Could not read ripgrep output:/);
  assert.equal(run.child.killed, true);
});

test('ripgrep errors and no-match exits retain their completion behavior', async () => {
  const empty = harness();
  await empty.close('', 1);
  assert.deepEqual(empty.completions, [undefined]);
  const invalid = harness();
  invalid.child.stderr.write('regex parse error: invalid pattern\n');
  await invalid.close('', 2);
  assert.deepEqual(invalid.completions, ['workspace: regex parse error: invalid pattern']);
});

test('bundled ripgrep searches Unicode separators and long lines across workspace roots', async () => {
  const first = await mkdtemp(join(tmpdir(), 'fuzzygrep-search-'));
  const second = await mkdtemp(join(tmpdir(), 'fuzzygrep-search-'));
  try {
    const text = 'x'.repeat(100000) + '😀\u2028needle\u2029 suffix\n';
    await writeFile(join(first, 'unicode\u2028file.txt'), text);
    await writeFile(join(second, 'other.txt'), 'another needle\n');
    const matches = [];
    const Search = load();
    const error = await new Promise((resolve) => {
      new Search(join(root, 'dist/bin/rg'), 'needle', [{ path: first, name: 'first' }, { path: second, name: 'second' }], {
        match: (match) => matches.push(match), done: resolve
      });
    });
    assert.equal(error, undefined);
    assert.equal(matches.length, 2);
    const long = matches.find((match) => match.label.startsWith('first/'));
    assert.equal(long.label, 'first/unicode\u2028file.txt');
    assert.equal(long.text, text.trimEnd());
    assert.deepEqual(long.ranges, [{ start: 100003, end: 100009 }]);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('base64 lines keep original byte offsets around malformed UTF-8', async () => {
  for (const prefix of [
    Buffer.from([0x61, 0xe9, 0x20]),
    Buffer.from([0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80]),
    Buffer.concat([Buffer.from('😀é'), Buffer.from([0xf0, 0x9f, 0x92]), Buffer.from(' ')])
  ]) {
    const run = harness();
    const bytes = Buffer.concat([prefix, Buffer.from('needle\n')]);
    await run.close(JSON.stringify({ type: 'match', data: {
      path: { bytes: Buffer.from('./fixture.txt').toString('base64') },
      lines: { bytes: bytes.toString('base64') }, line_number: 1,
      submatches: [{ start: prefix.length, end: prefix.length + 6 }]
    } }) + '\n');
    assert.deepEqual(run.completions, [undefined]);
    const match = run.matches[0];
    const column = prefix.toString('utf8').length;
    assert.equal(match.text, bytes.toString('utf8').trimEnd());
    assert.equal(match.column, column);
    assert.deepEqual(match.ranges, [{ start: column, end: column + 6 }]);
    assert.equal(match.text.slice(match.ranges[0].start, match.ranges[0].end), 'needle');
  }
});

test('byte-mode offsets inside UTF-8 sequences agree with decoded prefixes', async () => {
  const run = harness();
  const bytes = Buffer.concat([
    Buffer.from('aé中😀'),
    Buffer.from([0xf0, 0x9f, 0x92, 0x20, 0xe0, 0x80, 0x80, 0xed, 0xa0, 0x80, 0xff])
  ]);
  const submatches = Array.from({ length: bytes.length + 1 }, (_, start) => ({ start, end: start }));
  await run.close(JSON.stringify({ type: 'match', data: {
    path: { text: './fixture.txt' }, lines: { bytes: bytes.toString('base64') }, line_number: 1, submatches
  } }) + '\n');
  assert.deepEqual(run.completions, [undefined]);
  assert.deepEqual(run.matches[0].ranges, submatches.map(({ start }) => {
    const column = bytes.subarray(0, start).toString('utf8').length;
    return { start: column, end: column };
  }));
});

test('dense submatches on a long line convert offsets without decoding repeated prefixes', async () => {
  const run = harness();
  const text = 'x'.repeat(80000);
  const submatches = Array.from(text, (_, start) => ({ start, end: start + 1 }));
  const json = JSON.stringify({ type: 'match', data: {
    path: { text: './fixture.txt' }, lines: { text }, line_number: 1, submatches
  } }) + '\n';
  const original = Buffer.prototype.toString;
  let decodedBytes = 0;
  Buffer.prototype.toString = function (encoding, start = 0, end = this.length) {
    if (encoding === 'utf8') decodedBytes += end - start;
    return original.call(this, encoding, start, end);
  };
  try {
    await run.close(json);
  } finally {
    Buffer.prototype.toString = original;
  }
  assert.deepEqual(run.completions, [undefined]);
  assert.deepEqual(run.matches[0].ranges, submatches);
  assert(decodedBytes < json.length + text.length * 2, 'decoding work must stay proportional to the input');
});
