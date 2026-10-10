# Fuzzygrep

A local TypeScript extension for VS Code and Cursor. Search workspace file
contents with ripgrep in a dedicated bottom panel, navigate matching lines,
and preview context before opening a result. Initial target: **macOS arm64**.

This project is developed primarily for personal use.

## License

All rights reserved. Fuzzygrep's original source code and documentation are
not offered under an open-source license; see `LICENSE`.
Third-party components retain their own licenses, documented in
`THIRD_PARTY_NOTICES.md`.

## Setup and local installation

Use Node.js 22 or newer on an Apple Silicon Mac:

```sh
npm install

# Build, package, and install into the default profile
npm run install:vscode
npm run install:cursor

# Install into a named profile (names containing spaces are supported)
npm run install:vscode -- --profile "Work"
npm run install:cursor -- --profile "Work"
```

Each install command installs missing build dependencies (including dev
dependencies), builds `dist/fuzzygrep.vsix`, and installs it with the editor's
CLI. You can run an install command directly on a fresh checkout; `npm install`
is optional for these commands. `--profile="Work"` is also accepted. Omit the
flag for the default profile. The editor's `code` or `cursor` command must be in your PATH; use
**Shell Command: Install 'code' command in PATH** (or the Cursor equivalent)
in the Command Palette if needed. Reload an existing editor window after
installing an updated build.

The profile flag follows the [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line#_working-with-extensions).
Profiles may be created by the editor when a supplied name does not exist.

To build a VSIX without installing it:

```sh
npm run package
```

The VSIX includes its own ripgrep binary and requires no global `rg` or `fzf`
installation. Packaging is local; no Marketplace account is required.

## Using the panel

Open a workspace and run **Fuzzygrep: Toggle Search Panel**, or press
**Ctrl + Alt + Cmd + Shift + F** on macOS. A Hyper key remapper can emit this
combination. When the panel is visible but unfocused, the shortcut focuses its
search input. When the panel has focus, the shortcut hides it. Reopening preserves the query,
results, selected match, and results scroll position during the editor session.

| Key | Action |
| --- | --- |
| Up / Down | Select the previous / next match and update the preview |
| Enter | Open the selected match at its line and column |
| Alt + Enter | Open the selected match in another editor pane |
| Escape | Clear the query and results and hide the panel |
| Tab | Move between the query, clear button, results, and preview |

Click a matching line to select it; double-click to open it.
Search is debounced as you type and streams
results from all local workspace folders. Queries are regular expressions,
with smart case (lowercase queries are case insensitive; uppercase makes them
case sensitive). Invalid regexes and ripgrep errors appear in the panel.
Ripgrep's normal ignore rules apply, including `.gitignore`, `.ignore`, and
`.rgignore`. Hidden files and binary files are skipped by default. Searches
read saved file contents on disk.

The results list shows `path:line` followed by the matching source line, with
matches highlighted and the total below the results and preview panes.
Keyboard hints appear in the empty results area. The panel shows at most 5,000 matching
lines and asks you to narrow the query when the limit is reached. Preview uses
the installed language extensions' TextMate grammars and the active color theme's
token colors and font styles, including `editor.tokenColorCustomizations`.
Changing themes updates the current preview, and search matches stay highlighted.
It shows eight lines of context on each side;
files larger than 5 MiB show only the matching line. Remote hosts on other
platforms and virtual workspaces are outside this initial version's scope.

### Excluding dependencies and generated files

Create a `.rgignore` file in your workspace root to exclude directories from
Fuzzygrep searches. It uses the same pattern syntax as `.gitignore`:

```gitignore
node_modules/
dist/
build/
coverage/
```

Choose the output directories that apply to your project. These patterns
exclude matching directories anywhere below the `.rgignore` file, including
dependencies and outputs inside packages in a monorepo.

`.rgignore` only affects ripgrep searches; it does not change which files Git
tracks. It works even when the workspace is not a Git repository, whereas
`.gitignore` rules normally require a Git repository. When rules conflict,
`.rgignore` takes precedence over `.ignore` and `.gitignore`.

## Development

```sh
npm run build       # Type-check, compile, and copy the bundled ripgrep
npm run typecheck   # Check TypeScript without building
npm run watch       # Rebuild TypeScript on changes
```

Press **F5** in VS Code or Cursor using the included **Run Fuzzygrep** launch
configuration to start an Extension Development Host. Re-run `build` after
changing CSS. This is a local prototype; the publisher ID is `local-dev`.

## Manual checks

In both editors on macOS arm64:

1. Search for a known string, move several results down, toggle the panel
   twice, and confirm the query, selected row, preview, and scroll position.
   Focus the editor while the panel stays visible, then press the shortcut:
   it should focus the search input. Press it again to hide the panel.
2. Press Escape, reopen, and confirm the search is empty.
3. Use arrows from the input, then Tab to the results and use arrows again.
   Type J/K in the query input and confirm they appear in the query.
4. Open a result with Enter and with Alt + Enter; check its line and column,
   including a match following emoji or accented characters.
5. Search a regex, an invalid regex, a string with no matches, and a string
   present only in ignored files. Check status and error messages.
6. Change a query during a large search and confirm that results from the old
   search do not reappear. Search across a workspace with multiple folders.
7. Confirm that result rows show `path:line` followed by the matching source
   line, with matches highlighted, and totals sit below both panes. Check that
   keyboard hints appear in the empty results area and the empty preview has
   no heading or placeholder. Preview TypeScript, Python, and HTML, including a
   multiline comment or string beginning above the preview. Switch between custom light and dark
   themes while the preview is open, and check token color customizations.
