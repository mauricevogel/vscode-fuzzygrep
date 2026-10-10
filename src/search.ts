import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, join, relative } from 'node:path';
import type { SearchMatch } from './protocol';

interface RgText { text?: string; bytes?: string }
interface RgMatch {
  type: string;
  data: {
    path: RgText;
    lines: RgText;
    line_number: number;
    submatches: { start: number; end: number }[];
  };
}
export interface SearchRoot { path: string; name: string }
export interface SearchCallbacks {
  match: (match: SearchMatch) => void;
  done: (error?: string) => void;
}
const decode = (value: RgText): string => value.text ?? Buffer.from(value.bytes ?? '', 'base64').toString('utf8');

function matchRanges(bytes: Buffer, submatches: RgMatch['data']['submatches']): SearchMatch['ranges'] {
  let byte = 0;
  let column = 0;
  // Ripgrep emits ordered, non-overlapping submatches. Scan each UTF-8 unit
  // once, including malformed sequences that decode to replacement characters.
  const offset = (target: number): number => {
    target = Math.min(target, bytes.length);
    while (byte < target) {
      const first = bytes[byte];
      const width = first >= 0xc2 && first <= 0xdf ? 2
        : first >= 0xe0 && first <= 0xef ? 3
        : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
      let length = 1;
      while (length < width && byte + length < bytes.length) {
        const next = bytes[byte + length];
        const min = length === 1 && first === 0xe0 ? 0xa0 : length === 1 && first === 0xf0 ? 0x90 : 0x80;
        const max = length === 1 && first === 0xed ? 0x9f : length === 1 && first === 0xf4 ? 0x8f : 0xbf;
        if (next < min || next > max) break;
        length++;
      }
      // A byte-mode regex can end inside a character; its incomplete prefix
      // decodes to one replacement character, without advancing the scanner.
      if (byte + length > target) return column + 1;
      byte += length;
      column += length === 4 ? 2 : 1;
    }
    return column;
  };
  return submatches.map(({ start, end }) => ({ start: offset(start), end: offset(end) }));
}

export class RipgrepSearch {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private cancelled = false;

  constructor(binary: string, query: string, roots: SearchRoot[], callbacks: SearchCallbacks) {
    let remaining = roots.length;
    const errors: string[] = [];
    for (const root of roots) {
      const child = spawn(binary, ['--json', '--line-buffered', '--color', 'never', '--smart-case', '--no-config', '--regexp', query, '--', '.'], { cwd: root.path, windowsHide: true });
      this.children.add(child);
      // Ripgrep delimits JSON records with LF. Readline also splits at Unicode
      // separators in newer Node versions, even when they occur inside strings.
      child.stdout.setEncoding('utf8');
      let pending = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        pending = '';
        this.children.delete(child);
        if (error) errors.push(`${root.name}: ${error}`);
        if (--remaining === 0 && !this.cancelled) callbacks.done(errors.length ? errors.join('\n') : undefined);
      };
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.on('error', (error) => finish(`Could not start bundled ripgrep: ${error.message}`));
      child.on('close', (code, signal) => finish(code !== 0 && code !== 1 ? stderr.trim() || `ripgrep exited with ${code ?? signal}.` : undefined));
      const readLine = (line: string) => {
        if (this.cancelled || settled) return;
        try {
          const event = JSON.parse(line) as RgMatch;
          if (event.type !== 'match') return;
          const data = event.data;
          const rgFile = decode(data.path);
          const path = isAbsolute(rgFile) ? rgFile : join(root.path, rgFile);
          const bytes = data.lines.text !== undefined ? Buffer.from(data.lines.text, 'utf8') : Buffer.from(data.lines.bytes ?? '', 'base64');
          const raw = bytes.toString('utf8');
          // ripgrep reports UTF-8 byte offsets; VS Code and the webview use UTF-16.
          const ranges = matchRanges(bytes, data.submatches);
          callbacks.match({ path, label: `${roots.length > 1 ? `${root.name}/` : ''}${relative(root.path, path)}`, line: data.line_number - 1, column: ranges[0]?.start ?? 0, text: raw.replace(/\r?\n$/, ''), ranges });
        } catch (error) {
          this.cancel();
          callbacks.done(`Could not read ripgrep output: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      child.stdout.on('data', (chunk: string) => {
        if (this.cancelled || settled) return;
        pending += chunk;
        let start = 0;
        let end: number;
        while ((end = pending.indexOf('\n', start)) !== -1) {
          readLine(pending.slice(start, end));
          if (this.cancelled || settled) {
            pending = '';
            return;
          }
          start = end + 1;
        }
        pending = pending.slice(start);
      });
      child.stdout.on('end', () => {
        if (pending) readLine(pending);
        pending = '';
      });
    }
    if (roots.length === 0) queueMicrotask(() => callbacks.done('Open a local workspace folder to search.'));
  }

  cancel(): void {
    this.cancelled = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
