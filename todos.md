# codeswim-vscode todos

Items the Electron app has shipped that the VS Code extension hasn't yet — keep
the two in rough parity so users get the same behavior in either surface.

## Line-range navigation parity

The Electron app accepts GitHub-style line refs in navigate targets:
`click X call navigate("../src/server.ts#L10-L22")` jumps to and highlights
lines 10–22. The extension currently strips the fragment at
[`src/extension.ts:150`](src/extension.ts#L150) (`raw.split('#')[0]`) and opens
the file at the top.

To match:

1. Parse the fragment with `/^L(\d+)(?:-L?(\d+))?$/i` (accept `#L10`, `#L10-L22`,
   `#L10-22`). 1-indexed, inclusive.
2. When the target is a non-`.md` file AND there's a range, open via
   `vscode.window.showTextDocument(targetUri, { viewColumn: vscode.ViewColumn.One, preserveFocus: false, selection: new vscode.Range(start - 1, 0, end - 1, Number.MAX_SAFE_INTEGER) })`.
   VS Code reveals the selection automatically; no extra scroll call needed.
3. When the target is `.md` AND there's a range, open as text (with selection)
   rather than as a new webview — line refs only make sense in source view.
   Mirrors the Electron `load-success` reducer which forces `view: 'code'` when
   `range` is set.

Reference implementation: `parseTarget` in
[`../codeswim/src/renderer/src/path-utils.ts`](../codeswim/src/renderer/src/path-utils.ts).

## Keep mermaid-lint in sync with the harness validator

[`src/mermaid-lint.ts`](src/mermaid-lint.ts) mirrors
[`../codeswim/src/harness/tool/diagram-edit.ts`](../codeswim/src/harness/tool/diagram-edit.ts) — both files have
a header comment pointing at each other. Whenever a new check is added on
either side, mirror it. Current checks: (1) `click ... call navigate(...)`
in non-flowchart diagrams, (2) `{` inside an unquoted `[...]` label.

Possible future checks worth adding to both:
- Unbalanced quotes inside labels.
- Mermaid blocks whose diagram type can't be detected.

## Optional: coverage CLI reports nodes missing click handlers

The Electron app's system prompt requires every flowchart node to have a
`click ... call navigate(...)` handler. The CLI in
[`src/cli.ts`](src/cli.ts) doesn't surface that drift today. Could add a
4th check ("nodes without click handlers") that parses each flowchart
block, counts node IDs vs explicit click targets, and reports mismatches
the same way broken links / orphan diagrams / uncovered sources are
listed. Useful for CI and for agents auditing a workspace.
