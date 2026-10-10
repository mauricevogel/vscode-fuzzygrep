export interface MatchRange { start: number; end: number }
export interface SearchMatch {
  path: string;
  label: string;
  line: number;
  column: number;
  text: string;
  ranges: MatchRange[];
}
export interface SyntaxToken extends MatchRange { color?: string; fontStyle?: number }
export interface PreviewTheme { id: string; foreground: string; background: string }
export interface PreviewLine { line: number; text: string; ranges: MatchRange[]; tokens?: SyntaxToken[] }
export interface Preview { label: string; lines: PreviewLine[]; error?: string }
export interface SearchState {
  revision: number;
  query: string;
  results: SearchMatch[];
  selected: number;
  searching: boolean;
  error?: string;
  truncated: boolean;
  preview?: Preview;
}
export type ClientMessage =
  | { type: 'ready' }
  | { type: 'focusChanged'; focused: boolean }
  | { type: 'theme'; theme: PreviewTheme }
  | { type: 'search'; query: string; revision: number }
  | { type: 'select'; index: number; revision: number }
  | { type: 'open'; index: number; beside: boolean; revision: number }
  | { type: 'escape' }
  | { type: 'toggle' };
export type HostMessage =
  | { type: 'state'; state: SearchState }
  | { type: 'results'; revision: number; matches: SearchMatch[]; selected: number }
  | { type: 'status'; revision: number; searching: boolean; truncated: boolean; error?: string }
  | { type: 'preview'; revision: number; index: number; preview: Preview }
  | { type: 'focus' };
