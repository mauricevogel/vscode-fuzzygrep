# VS Code and Cursor Quick Search Extension

## Summary

Create a TypeScript extension for VS Code and Cursor with a dedicated search view in the bottom panel. Users search workspace contents with ripgrep, browse matching files and lines, preview the selected result, and open a match in the editor.

## Implementation

- Add a command and panel view for search. Bind **Hyperkey + F** to toggle the panel; hiding and reopening it preserves the query, results, and selected result position.
- VS Code has no native Hyper modifier. On macOS, define the default binding as **Ctrl + Alt + Cmd + Shift + F**, the modifier combination commonly used by Hyper key remappers.
- Bundle ripgrep for macOS arm64. Search the active workspace using ripgrep’s standard ignore rules, and stream results into the panel.
- Show matching files and lines in a navigable results list. Update a preview when the selected result changes.
- **Enter** opens the selected match at its found position. **Alt + Enter** opens it in a new editor pane.
- **Up/Down** navigate results. **J/K** do the same when the results list has focus; when the query input has focus, they remain available for typing.
- **Escape** hides the panel and clears the query and current search results.
- Use ripgrep alone for v1; the panel provides browsing and preview, so fzf is not required.

## Test Plan

- Verify the shortcut toggles the panel while preserving the query, results, and selected result.
- Check that Escape closes the panel and clears the query and results.
- Confirm arrow and J/K navigation, including normal J/K typing in the query input.
- Verify Enter opens the selected match at the correct position, Alt + Enter opens it in a new pane, and selection updates the preview.
- Test regex searches, ignored files, empty results, and ripgrep errors in VS Code and Cursor on macOS arm64.

## Assumptions

- macOS arm64 is the initial target; other platforms can follow.
- “Search” means searching file contents; file-name search and replace are outside v1.
- The Hyperkey shortcut depends on the user’s key remapper mapping Hyper to Ctrl + Alt + Cmd + Shift.
