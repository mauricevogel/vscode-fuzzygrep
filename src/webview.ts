import type { ClientMessage, HostMessage, MatchRange, Preview, PreviewLine, SearchMatch, SearchState } from './protocol';

declare function acquireVsCodeApi(): { postMessage: (message: ClientMessage) => void; getState: () => { scrollTop?: number } | undefined; setState: (state: { scrollTop: number }) => void };
const vscode = acquireVsCodeApi();
const input = document.getElementById('query') as HTMLInputElement;
const list = document.getElementById('results') as HTMLDivElement;
const pane = document.getElementById('results-pane') as HTMLElement;
const status = document.getElementById('status') as HTMLDivElement;
const empty = document.getElementById('empty') as HTMLDivElement;
const preview = document.getElementById('preview') as HTMLDivElement;
const previewTitle = document.getElementById('preview-title') as HTMLDivElement;
const syntaxColors = document.getElementById('syntax-colors') as HTMLStyleElement;
const validColor = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
let state: SearchState = { revision: 0, query: '', results: [], selected: -1, searching: false, truncated: false };
let rows: HTMLElement[] = [];
let selectedRow: HTMLElement | undefined;

function highlighted(text: string, ranges: MatchRange[], offset = 0, last = true): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const range of ranges) {
    if (range.end < offset || range.start > offset + text.length) continue;
    if (range.start === range.end && range.start === offset + text.length && !last) continue;
    const start = Math.max(position, Math.min(range.start - offset, text.length));
    const end = Math.max(start, Math.min(range.end - offset, text.length));
    if (start === end && range.start !== range.end) continue;
    fragment.append(document.createTextNode(text.slice(position, start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end) || '▏';
    fragment.append(mark);
    position = end;
  }
  fragment.append(document.createTextNode(text.slice(position)));
  return fragment;
}

function syntaxHighlighted(line: PreviewLine): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!line.tokens?.length) return highlighted(line.text, line.ranges);
  let position = 0;
  for (const token of line.tokens) {
    if (token.start > position) fragment.append(highlighted(line.text.slice(position, token.start), line.ranges, position, false));
    const span = document.createElement('span');
    if (token.color && validColor.test(token.color)) span.classList.add(`syntax-${token.color.slice(1)}`);
    const style = token.fontStyle ?? 0;
    if (style & 1) span.classList.add('syntax-italic');
    if (style & 2) span.classList.add('syntax-bold');
    if (style & 4) span.classList.add('syntax-underline');
    if (style & 8) span.classList.add('syntax-strikethrough');
    span.append(highlighted(line.text.slice(token.start, token.end), line.ranges, token.start, token.end === line.text.length));
    fragment.append(span);
    position = token.end;
  }
  if (position < line.text.length) fragment.append(highlighted(line.text.slice(position), line.ranges, position));
  return fragment;
}

function append(matches: SearchMatch[], offset: number): void {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const index = offset + i;
    const row = document.createElement('div');
    row.id = `match-${index}`;
    row.className = 'match';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('aria-label', `${match.label}, line ${match.line + 1}`);
    row.dataset.index = String(index);
    row.textContent = `${match.label}:${match.line + 1}`;
    row.title = row.textContent;
    fragment.append(row);
    rows.push(row);
  }
  list.append(fragment);
}

function paintSelection(scroll: boolean): void {
  selectedRow?.classList.remove('selected');
  selectedRow?.setAttribute('aria-selected', 'false');
  selectedRow = rows[state.selected];
  if (selectedRow) {
    selectedRow.classList.add('selected');
    selectedRow.setAttribute('aria-selected', 'true');
    list.setAttribute('aria-activedescendant', selectedRow.id);
    if (scroll) selectedRow.scrollIntoView({ block: 'nearest' });
  } else list.removeAttribute('aria-activedescendant');
}

function paintStatus(): void {
  const count = state.results.length;
  const files = new Set(state.results.map((match) => match.path)).size;
  status.classList.toggle('error', Boolean(state.error));
  status.textContent = state.error ?? (state.searching ? `Searching… ${count.toLocaleString()} matching lines` : state.query ? `${count.toLocaleString()} matching lines in ${files.toLocaleString()} files${state.truncated ? ' · Result limit reached; narrow your query.' : ''}` : 'Regex · smart case · respects ripgrep ignore rules');
  empty.hidden = count > 0;
  empty.textContent = state.error ? 'Update your query or workspace and try again.' : state.searching ? 'Searching workspace…' : state.query ? 'No matching lines.' : 'Type a query to search workspace contents.';
  list.setAttribute('aria-busy', String(state.searching));
}

function paintPreview(value?: Preview): void {
  const colors = new Set(value?.lines.flatMap((line) => line.tokens?.map((token) => token.color) ?? []) ?? []);
  syntaxColors.textContent = [...colors].filter((color): color is string => Boolean(color && validColor.test(color)))
    .map((color) => `.syntax-${color.slice(1)} { color: ${color}; }`).join('\n');
  preview.replaceChildren();
  previewTitle.textContent = value?.label ?? 'Preview';
  previewTitle.title = value?.label ?? '';
  if (!value) {
    preview.textContent = state.selected >= 0 ? 'Loading preview…' : 'Select a match to preview its context.';
    return;
  }
  if (value.error) {
    const message = document.createElement('div');
    message.className = 'preview-message';
    message.textContent = value.error;
    preview.append(message);
  }
  const selected = state.results[state.selected];
  for (const line of value.lines) {
    const row = document.createElement('div');
    row.className = `preview-line${line.line === selected?.line ? ' current-line' : ''}`;
    const number = document.createElement('span');
    number.className = 'line-number';
    number.textContent = String(line.line + 1);
    const text = document.createElement('span');
    text.append(syntaxHighlighted(line));
    row.append(number, text);
    preview.append(row);
  }
  preview.scrollTop = 0;
}

function select(index: number): void {
  if (!state.results.length) return;
  state.selected = Math.max(0, Math.min(state.results.length - 1, index));
  state.preview = undefined;
  paintSelection(true);
  paintPreview();
  vscode.postMessage({ type: 'select', index: state.selected, revision: state.revision });
}

input.addEventListener('input', () => {
  // Clear stale rows immediately so Enter cannot open a result from an old query.
  state = { revision: state.revision + 1, query: input.value, results: [], selected: -1, searching: Boolean(input.value), truncated: false };
  rows = [];
  selectedRow = undefined;
  list.replaceChildren();
  paintStatus();
  paintPreview();
  vscode.postMessage({ type: 'search', query: input.value, revision: state.revision });
});
document.getElementById('clear')?.addEventListener('click', () => vscode.postMessage({ type: 'escape' }));
list.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.match');
  if (!row) return;
  list.focus();
  select(Number(row.dataset.index));
});
list.addEventListener('dblclick', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.match');
  if (row) vscode.postMessage({ type: 'open', index: Number(row.dataset.index), beside: event.altKey, revision: state.revision });
});
pane.addEventListener('scroll', () => vscode.setState({ scrollTop: pane.scrollTop }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: 'escape' });
    return;
  }
  if (event.key.toLowerCase() === 'f' && event.ctrlKey && event.altKey && event.shiftKey && event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: 'toggle' });
    return;
  }
  if (event.key === 'Enter' && (document.activeElement === input || document.activeElement === list || document.activeElement === preview)) {
    event.preventDefault();
    if (state.selected >= 0) vscode.postMessage({ type: 'open', index: state.selected, beside: event.altKey, revision: state.revision });
    return;
  }
  const inResults = document.activeElement === list;
  const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (plainKey && (event.key === 'ArrowDown' || (inResults && event.key === 'j'))) {
    event.preventDefault();
    select(state.selected + 1);
  } else if (plainKey && (event.key === 'ArrowUp' || (inResults && event.key === 'k'))) {
    event.preventDefault();
    select(state.selected - 1);
  }
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'state': {
      if (message.state.revision < state.revision) return;
      const scroll = message.state.revision === state.revision ? pane.scrollTop || vscode.getState()?.scrollTop || 0 : 0;
      state = message.state;
      input.value = state.query;
      rows = [];
      selectedRow = undefined;
      list.replaceChildren();
      append(state.results, 0);
      paintSelection(false);
      paintStatus();
      paintPreview(state.preview);
      pane.scrollTop = state.query ? scroll : 0;
      break;
    }
    case 'results': {
      if (message.revision !== state.revision) return;
      const offset = state.results.length;
      state.results.push(...message.matches);
      if (state.selected < 0) state.selected = message.selected;
      append(message.matches, offset);
      paintSelection(false);
      paintStatus();
      break;
    }
    case 'status':
      if (message.revision !== state.revision) return;
      state.searching = message.searching;
      state.error = message.error;
      state.truncated = message.truncated;
      paintStatus();
      break;
    case 'preview':
      if (message.revision !== state.revision || message.index !== state.selected) return;
      state.preview = message.preview;
      paintPreview(message.preview);
      break;
    case 'focus': input.focus(); break;
  }
});

function reportFocus(): void {
  vscode.postMessage({ type: 'focusChanged', focused: document.hasFocus() });
}
window.addEventListener('focus', reportFocus);
window.addEventListener('blur', reportFocus);

function hexColor(value: string): string {
  if (validColor.test(value)) return value;
  const components = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return components ? `#${components.slice(1).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}` : '';
}

function reportTheme(): void {
  const style = getComputedStyle(preview);
  vscode.postMessage({ type: 'theme', theme: {
    id: document.body.dataset.vscodeThemeId ?? '',
    foreground: hexColor(style.color),
    background: hexColor(style.backgroundColor)
  } });
}
// The webview exposes the exact active theme ID, including theme picker previews.
new MutationObserver(reportTheme).observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-id', 'class', 'style'] });
reportTheme();
vscode.postMessage({ type: 'ready' });
reportFocus();
