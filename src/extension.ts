import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { RipgrepSearch } from './search';
import { PreviewHighlighter } from './syntax';
import type { ClientMessage, HostMessage, Preview, SearchMatch, SearchState } from './protocol';

const VIEW_ID = 'fuzzygrep.search';
const RESULT_LIMIT = 5000;
const initialState = (revision = 0): SearchState => ({ revision, query: '', results: [], selected: -1, searching: false, truncated: false });

class SearchView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private focused = false;
  private state = initialState();
  private search?: RipgrepSearch;
  private searchVersion = 0;
  private previewVersion = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private batchTimer?: ReturnType<typeof setTimeout>;
  private pending: SearchMatch[] = [];
  private disposables: vscode.Disposable[] = [];
  private readonly highlighter: PreviewHighlighter;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.highlighter = new PreviewHighlighter(extensionUri);
    this.disposables.push(this.highlighter);
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.startSearch(this.state.query)));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editor.tokenColorCustomizations')) {
        this.highlighter.refreshTheme();
        this.refreshPreview();
      }
    }));
    this.disposables.push(vscode.extensions.onDidChange(() => this.refreshPreview()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    view.webview.html = this.html(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        void this.handleMessage(message as ClientMessage).catch((error: unknown) => {
          void vscode.window.showErrorMessage(`Fuzzygrep: ${error instanceof Error ? error.message : String(error)}`);
        });
      }),
      view.onDidChangeVisibility(() => {
        if (!view.visible) this.focused = false;
        if (view.visible) {
          this.flush();
          this.post({ type: 'state', state: this.state });
          this.post({ type: 'focus' });
        }
      }),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.focused = false; } })
    );
  }

  async toggle(fromWebview = false): Promise<void> {
    if (this.view?.visible && (this.focused || fromWebview)) {
      this.focused = false;
      await vscode.commands.executeCommand('workbench.action.closePanel');
    } else {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      this.post({ type: 'focus' });
    }
  }

  async clearAndHide(): Promise<void> {
    this.focused = false;
    this.stopSearch();
    this.state = initialState(this.state.revision + 1);
    this.post({ type: 'state', state: this.state });
    await vscode.commands.executeCommand('workbench.action.closePanel');
  }

  private async handleMessage(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'focusChanged':
        if (typeof message.focused === 'boolean') this.focused = message.focused && this.view?.visible === true;
        break;
      case 'theme':
        if (message.theme && typeof message.theme.id === 'string' && typeof message.theme.foreground === 'string' && typeof message.theme.background === 'string') {
          if (this.highlighter.setTheme(message.theme)) this.refreshPreview();
        }
        break;
      case 'ready':
        this.flush();
        this.post({ type: 'state', state: this.state });
        this.post({ type: 'focus' });
        break;
      case 'search':
        if (typeof message.query === 'string' && Number.isInteger(message.revision) && message.revision >= this.state.revision) this.startSearch(message.query, message.revision);
        break;
      case 'select':
        if (message.revision === this.state.revision && this.validIndex(message.index)) this.select(message.index);
        break;
      case 'open':
        if (message.revision === this.state.revision && this.validIndex(message.index)) await this.open(this.state.results[message.index], message.beside === true);
        break;
      case 'escape': await this.clearAndHide(); break;
      case 'toggle': await this.toggle(true); break;
    }
  }

  private validIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.state.results.length;
  }

  private stopSearch(): void {
    this.searchVersion++;
    this.previewVersion++;
    this.search?.cancel();
    this.search = undefined;
    clearTimeout(this.debounce);
    clearTimeout(this.batchTimer);
    this.debounce = undefined;
    this.batchTimer = undefined;
    this.pending = [];
  }

  private startSearch(query: string, revision = this.state.revision + 1): void {
    this.stopSearch();
    this.state = { ...initialState(revision), query, searching: query.length > 0 };
    this.post({ type: 'state', state: this.state });
    if (!query) return;
    const version = this.searchVersion;
    const seen = new Map<string, Set<number>>();
    this.debounce = setTimeout(() => {
      if (version !== this.searchVersion) return;
      if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        this.finish('Fuzzygrep v1 supports macOS arm64 extension hosts.');
        return;
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.length || folders.some((folder) => folder.uri.scheme !== 'file')) {
        this.finish('Open a local workspace folder to search. Virtual workspaces are not supported.');
        return;
      }
      this.search = new RipgrepSearch(join(this.extensionUri.fsPath, 'dist/bin/rg'), query, folders.map((folder) => ({ path: folder.uri.fsPath, name: folder.name })), {
        match: (match) => {
          if (version !== this.searchVersion || !this.state.searching) return;
          let lines = seen.get(match.path);
          if (lines?.has(match.line)) return;
          if (!lines) seen.set(match.path, lines = new Set());
          lines.add(match.line);
          this.state.results.push(match);
          this.pending.push(match);
          if (this.state.selected === -1) this.state.selected = 0;
          if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flush(), 50);
          if (this.state.results.length >= RESULT_LIMIT) {
            this.state.truncated = true;
            this.search?.cancel();
            this.finish();
          }
        },
        done: (error) => { if (version === this.searchVersion) this.finish(error); }
      });
    }, 150);
  }

  private flush(): void {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (!this.pending.length) return;
    const matches = this.pending;
    this.pending = [];
    this.post({ type: 'results', revision: this.state.revision, matches, selected: this.state.selected });
    if (!this.state.preview && this.state.selected >= 0) this.select(this.state.selected);
  }

  private finish(error?: string): void {
    this.state.searching = false;
    this.state.error = error;
    this.flush();
    this.post({ type: 'status', revision: this.state.revision, searching: false, truncated: this.state.truncated, error });
  }

  private select(index: number): void {
    this.state.selected = index;
    this.state.preview = undefined;
    const version = ++this.previewVersion;
    const match = this.state.results[index];
    void this.preview(match).then((preview) => {
      if (version !== this.previewVersion) return;
      this.state.preview = preview;
      this.post({ type: 'preview', revision: this.state.revision, index, preview });
    });
  }

  private refreshPreview(): void {
    if (this.validIndex(this.state.selected)) this.select(this.state.selected);
  }

  private async preview(match: SearchMatch): Promise<Preview> {
    try {
      const uri = vscode.Uri.file(match.path);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 5 * 1024 * 1024) {
        return { label: match.label, lines: [{ line: match.line, text: match.text, ranges: match.ranges }], error: 'Large file: showing the matching line only.' };
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const start = Math.max(0, match.line - 8);
      const end = Math.min(document.lineCount - 1, match.line + 8);
      const lines = [];
      for (let line = start; line <= end; line++) {
        lines.push({ line, text: document.lineAt(line).text, ranges: line === match.line ? match.ranges : [] });
      }
      await this.highlighter.highlight(document, lines);
      return { label: match.label, lines };
    } catch (error) {
      return { label: match.label, lines: [], error: `Preview unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async open(match: SearchMatch, beside: boolean): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(match.path));
    const line = Math.min(match.line, document.lineCount - 1);
    const position = new vscode.Position(line, Math.min(match.column, document.lineAt(line).text.length));
    const editor = await vscode.window.showTextDocument(document, { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preview: false, selection: new vscode.Range(position, position) });
    this.focused = false;
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private post(message: HostMessage): void { void this.view?.webview.postMessage(message); }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist/webview.js'));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist/search.css'));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${stylesheet}"><style id="syntax-colors" nonce="${nonce}"></style><title>Fuzzygrep</title></head>
<body>
  <header><label for="query">Search workspace</label><input id="query" type="text" placeholder="Search contents with a regex…" spellcheck="false" autocomplete="off" aria-describedby="status"><button id="clear" title="Clear search and hide (Escape)" aria-label="Clear search and hide panel">×</button></header>
  <main><section id="results-pane" aria-label="Search results"><div id="empty"><div id="empty-message">Type a query to search workspace contents.</div><div class="shortcuts"><span>↑ ↓ navigate matches</span><span>Enter open</span><span>Alt Enter split</span><span>Esc clear &amp; hide</span></div></div><div id="results" role="listbox" aria-label="Matching lines" tabindex="0"></div></section>
  <section id="preview-pane" aria-label="Selected match preview"><div id="preview" tabindex="0"></div></section></main>
  <div id="status" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }

  dispose(): void {
    this.stopSearch();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SearchView(context.extensionUri);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('fuzzygrep.toggle', () => provider.toggle()),
    vscode.commands.registerCommand('fuzzygrep.clearAndHide', () => provider.clearAndHide())
  );
}
