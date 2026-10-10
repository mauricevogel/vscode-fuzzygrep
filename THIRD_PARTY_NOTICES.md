# Preview syntax highlighting

Fuzzygrep bundles Microsoft's MIT-licensed
[vscode-textmate](https://github.com/microsoft/vscode-textmate) 9.2.0 and
[vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma) 1.7.0 runtimes.
Their licenses and Oniguruma notices are copied into `dist` during the build.
The preview reads TextMate grammars supplied by installed editor extensions.
It also bundles Microsoft's MIT-licensed
[jsonc-parser](https://github.com/microsoft/node-jsonc-parser) 3.3.1 to read theme
files with comments. Its license is copied into `dist` during the build.

# Bundled ripgrep

Fuzzygrep bundles a macOS arm64 ripgrep binary supplied by Microsoft's
[@vscode/ripgrep](https://github.com/microsoft/vscode-ripgrep).
The wrapper's MIT license is copied to `dist/bin/LICENSE.ripgrep-wrapper.txt`
during the build.

The ripgrep binary is built from [ripgrep](https://github.com/BurntSushi/ripgrep),
Copyright (c) 2016 Andrew Gallant, and is distributed under the MIT license:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
