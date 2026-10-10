import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import type { PreviewLine, PreviewTheme, SyntaxToken } from './protocol';
import { loadPreviewTheme, type TextMateTheme } from './theme';

// Public API subset for the vendored TextMate 9.2.0 / Oniguruma 1.7.0 runtimes.
interface Grammar {
  tokenizeLine2(text: string, stack: unknown, timeLimit: number): {
    tokens: Uint32Array;
    ruleStack: unknown;
    stoppedEarly: boolean;
  };
}
interface Registry {
  loadGrammar(scope: string): Promise<Grammar | null>;
  setTheme(theme: TextMateTheme): void;
  getColorMap(): string[];
  dispose(): void;
}
const textmate: {
  INITIAL: unknown;
  parseRawGrammar(source: string, path: string): unknown;
  Registry: new (options: {
    onigLib: Promise<unknown>;
    loadGrammar: (scope: string) => Promise<unknown>;
    getInjections: (scope: string) => string[];
  }) => Registry;
} = require('../vendor/vscode-textmate/main.js');
const oniguruma: {
  loadWASM(data: Uint8Array): Promise<void>;
  OnigScanner: new (patterns: string[]) => unknown;
  OnigString: new (text: string) => unknown;
} = require('../vendor/vscode-oniguruma/main.js');

interface GrammarContribution { language?: string; scopeName: string; path: string; injectTo?: string[] }
interface CachedDocument { version: number; language: string; stack: unknown; tokens: SyntaxToken[][] }

export class PreviewHighlighter implements vscode.Disposable {
  private registry?: Registry;
  private grammars = new Map<string, Promise<Grammar | null>>();
  private scopes = new Map<string, string>();
  private documents = new WeakMap<vscode.TextDocument, CachedDocument>();
  private readonly onigLib: Promise<unknown>;
  private readonly changes: vscode.Disposable;
  private appearance?: PreviewTheme;
  private theme?: Promise<void>;
  private generation = 0;

  constructor(extensionUri: vscode.Uri) {
    this.onigLib = readFile(vscode.Uri.joinPath(extensionUri, 'dist/onig.wasm').fsPath)
      .then((data) => oniguruma.loadWASM(data))
      .then(() => ({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (text: string) => new oniguruma.OnigString(text)
      }));
    // A missing runtime must not prevent plain-text previews or search.
    void this.onigLib.catch(() => undefined);
    this.changes = vscode.extensions.onDidChange(() => this.reset());
  }

  setTheme(appearance: PreviewTheme): boolean {
    if (JSON.stringify(appearance) === JSON.stringify(this.appearance)) return false;
    this.appearance = appearance;
    this.reset();
    return true;
  }

  refreshTheme(): void { this.reset(); }

  private async grammar(language: string): Promise<Grammar | null> {
    if (!this.registry) {
      const sources = new Map<string, vscode.Uri>();
      const injections = new Map<string, string[]>();
      for (const extension of vscode.extensions.all) {
        const contributions = extension.packageJSON.contributes?.grammars as GrammarContribution[] | undefined;
        for (const contribution of contributions ?? []) {
          sources.set(contribution.scopeName, vscode.Uri.joinPath(extension.extensionUri, contribution.path));
          if (contribution.language) this.scopes.set(contribution.language, contribution.scopeName);
          for (const scope of contribution.injectTo ?? []) {
            injections.set(scope, [...(injections.get(scope) ?? []), contribution.scopeName]);
          }
        }
      }
      this.registry = new textmate.Registry({
        onigLib: this.onigLib,
        loadGrammar: async (scope) => {
          const uri = sources.get(scope);
          if (!uri) return null;
          const data = await vscode.workspace.fs.readFile(uri);
          return textmate.parseRawGrammar(Buffer.from(data).toString('utf8'), uri.path);
        },
        getInjections: (scope) => injections.get(scope) ?? []
      });
      const registry = this.registry;
      const generation = this.generation;
      this.theme = loadPreviewTheme(this.appearance).then((theme) => {
        if (generation === this.generation) registry.setTheme(theme);
      });
    }
    const generation = this.generation;
    await this.theme;
    if (generation !== this.generation) return null;
    const scope = this.scopes.get(language);
    if (!scope) return Promise.resolve(null);
    const loaded = this.grammars.get(language) ?? this.registry.loadGrammar(scope);
    this.grammars.set(language, loaded);
    return loaded;
  }

  async highlight(document: vscode.TextDocument, lines: PreviewLine[]): Promise<void> {
    try {
      const version = document.version;
      const generation = this.generation;
      const grammar = await this.grammar(document.languageId);
      if (!grammar || !lines.length || version !== document.version || generation !== this.generation) return;
      const colors = this.registry!.getColorMap();
      let cached = this.documents.get(document);
      if (!cached || cached.version !== document.version || cached.language !== document.languageId) {
        cached = { version: document.version, language: document.languageId, stack: textmate.INITIAL, tokens: [] };
        this.documents.set(document, cached);
      }
      // Tokenize from the beginning to preserve comments/strings opened above the preview.
      // Reuse prior lines when navigating within the same document.
      const deadline = performance.now() + 500;
      const end = lines[lines.length - 1].line;
      while (cached.tokens.length <= end && performance.now() < deadline) {
        const text = document.lineAt(cached.tokens.length).text;
        const result = grammar.tokenizeLine2(text, cached.stack, 200);
        if (result.stoppedEarly) break;
        cached.stack = result.ruleStack;
        const tokens: SyntaxToken[] = [];
        // TextMate metadata: font style in bits 11–14, foreground in bits 15–23.
        for (let i = 0; i < result.tokens.length; i += 2) {
          const metadata = result.tokens[i + 1];
          tokens.push({
            start: result.tokens[i],
            end: Math.min(text.length, result.tokens[i + 2] ?? text.length),
            color: colors[(metadata >>> 15) & 0x1ff],
            fontStyle: (metadata >>> 11) & 0xf
          });
        }
        cached.tokens.push(tokens);
      }
      for (const line of lines) line.tokens = cached.tokens[line.line];
    } catch {
      // Unsupported or broken third-party grammars fall back to plain text.
    }
  }

  private reset(): void {
    this.generation++;
    this.theme = undefined;
    this.registry?.dispose();
    this.registry = undefined;
    this.grammars.clear();
    this.scopes.clear();
    this.documents = new WeakMap();
  }

  dispose(): void { this.changes.dispose(); this.reset(); }
}
