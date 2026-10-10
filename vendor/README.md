# Preview tokenizer runtimes

Vendored, unmodified runtime assets from the locally installed Cursor distribution:

- `vscode-textmate` 9.2.0: https://github.com/microsoft/vscode-textmate
- `vscode-oniguruma` 1.7.0: https://github.com/microsoft/vscode-oniguruma

Both wrappers are MIT licensed; Oniguruma's additional notices are included.
These files allow offline builds. The build bundles both JavaScript runtimes and
copies the WASM runtime and license notices into `dist`. Grammars are loaded at
runtime from the editor's installed language extensions; no editor installation
path is embedded in the extension.
