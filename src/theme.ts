import * as vscode from 'vscode';
import { basename } from 'node:path';
// Use the ESM entry so esbuild can bundle the parser's internal imports.
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main';
import type { PreviewTheme } from './protocol';

export interface TokenSettings { foreground?: string; background?: string; fontStyle?: string }
export interface ThemeRule { scope?: string | string[]; settings: TokenSettings }
export interface TextMateTheme { settings: ThemeRule[] }
interface ThemeFile {
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: ThemeRule[] | string;
  settings?: ThemeRule[];
}
interface ThemeContribution { id?: string; label?: string; path: string }
interface TokenCustomizations {
  comments?: string | TokenSettings;
  strings?: string | TokenSettings;
  keywords?: string | TokenSettings;
  numbers?: string | TokenSettings;
  types?: string | TokenSettings;
  functions?: string | TokenSettings;
  variables?: string | TokenSettings;
  textMateRules?: ThemeRule[];
}
const groups = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword', 'storage'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable']
};
const { parseRawGrammar } = require('../vendor/vscode-textmate/main.js') as { parseRawGrammar: (source: string, path: string) => unknown };

async function readTheme(uri: vscode.Uri, ancestors = new Set<string>()): Promise<{ rules: ThemeRule[]; colors: Record<string, string> }> {
  const key = uri.toString();
  if (ancestors.has(key) || ancestors.size >= 32) throw new Error('Circular theme include');
  ancestors.add(key);
  try {
    const source = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const errors: ParseError[] = [];
    const theme = (uri.path.toLowerCase().endsWith('.tmtheme')
      ? parseRawGrammar(source, uri.path)
      : parse(source, errors, { allowTrailingComma: true })) as ThemeFile;
    if (errors.length || !theme || typeof theme !== 'object') throw new Error('Invalid theme');
    const result = theme.include
      ? await readTheme(vscode.Uri.joinPath(uri, '..', theme.include), ancestors)
      : { rules: [] as ThemeRule[], colors: {} as Record<string, string> };
    Object.assign(result.colors, theme.colors);
    if (Array.isArray(theme.settings)) result.rules.push(...theme.settings);
    if (Array.isArray(theme.tokenColors)) result.rules.push(...theme.tokenColors);
    else if (typeof theme.tokenColors === 'string') {
      const tokens = await readTheme(vscode.Uri.joinPath(uri, '..', theme.tokenColors), ancestors);
      result.rules.push(...tokens.rules);
    }
    return result;
  } finally { ancestors.delete(key); }
}

function customizationRules(custom: TokenCustomizations): ThemeRule[] {
  const rules: ThemeRule[] = [];
  for (const group of Object.keys(groups) as (keyof typeof groups)[]) {
    const value = custom[group];
    if (value) rules.push({ scope: groups[group], settings: typeof value === 'string' ? { foreground: value } : value });
  }
  if (Array.isArray(custom.textMateRules)) rules.push(...custom.textMateRules);
  return rules;
}

function matchesTheme(key: string, id: string): boolean {
  return [...key.matchAll(/\[([^\]]+)\]/g)].some(([, pattern]) => {
    const expression = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${expression}$`).test(id);
  });
}

export async function loadPreviewTheme(appearance?: PreviewTheme): Promise<TextMateTheme> {
  const configuration = vscode.workspace.getConfiguration();
  const id = appearance?.id || configuration.get<string>('workbench.colorTheme', '');
  let rules: ThemeRule[] = [];
  let colors: Record<string, string> = {};
  try {
    for (const extension of vscode.extensions.all) {
      const themes = extension.packageJSON.contributes?.themes as ThemeContribution[] | undefined;
      const theme = themes?.find((candidate) => (candidate.id || candidate.label || basename(candidate.path, '.json')) === id);
      if (!theme) continue;
      ({ rules, colors } = await readTheme(vscode.Uri.joinPath(extension.extensionUri, theme.path)));
      break;
    }
  } catch {
    // Missing/malformed themes still use the editor foreground and user rules.
  }
  const custom = configuration.get<TokenCustomizations & Record<string, unknown>>('editor.tokenColorCustomizations', {});
  rules.push(...customizationRules(custom));
  const scoped: TokenCustomizations = {};
  for (const [key, value] of Object.entries(custom)) {
    if (!key.startsWith('[') || !matchesTheme(key, id) || !value || typeof value !== 'object') continue;
    const override = value as TokenCustomizations;
    const textMateRules = [...(scoped.textMateRules ?? []), ...(override.textMateRules ?? [])];
    Object.assign(scoped, override, { textMateRules });
  }
  rules.push(...customizationRules(scoped));
  const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
  return { settings: [
    { settings: {
      foreground: appearance?.foreground || colors['editor.foreground'] || (light ? '#000000' : '#FFFFFF'),
      background: appearance?.background || colors['editor.background'] || (light ? '#FFFFFF' : '#000000')
    } },
    ...rules.filter((rule) => rule.scope && rule.settings)
  ] };
}
