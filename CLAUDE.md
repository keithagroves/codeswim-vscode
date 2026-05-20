# codeswim — VS Code extension

A VS Code extension that renders mermaid diagrams from markdown files and
makes their nodes clickable for navigation. Companion to the standalone
Electron app at `~/projects/codeswim` and the example project at
`~/projects/codeswim-example`.

## Commands

| | |
|---|---|
| `npm run build` | esbuild bundles the extension, webview, and CLI |
| `npm run watch` | rebuilds on change (unminified, source maps inline) |
| `npm run typecheck` | `tsc --noEmit` for all source + tests |
| `npm test` | runs vitest once |
| `npm run test:watch` | vitest in watch mode |
| `npm run coverage [path]` | runs the coverage CLI on a path (default cwd) |
| `npm run package` | produces `codeswim-X.Y.Z.vsix` |

## CLI for agents and CI

`out/cli.js` is the same coverage analysis surfaced by the extension's
"Check coverage" button, runnable from a shell. Exposed via the package's
`bin` entry as `codeswim-coverage`.

```bash
node out/cli.js /path/to/repo               # human-readable
node out/cli.js /path/to/repo --json        # machine-readable
node out/cli.js /path/to/repo --strict      # exit 1 on any drift
```

This is the agent-friendly path for verifying alignment after editing
docs/code without needing to launch VS Code.

A project can place a `.codeswimignore` at its root to add ignore
patterns on top of the built-in defaults (node_modules, dist, out, build,
.git, .vscode). Syntax is a gitignore subset: globs (`*` / `**` / `?`),
trailing `/` for directory-only, leading `/` to anchor at the workspace
root, leading `!` to negate. The CLI and the extension both honor it.

When packaging, bump the version in `package.json` so the install picks
up cleanly (`code --install-extension <vsix> --force` then reload window).

## Architecture

Two TypeScript entry points, bundled separately by esbuild:

- **`src/extension.ts`** — runs in the Node-hosted extension host.
  Registers commands, owns the webview panel lifecycle, watches files
  via `vscode.workspace.createFileSystemWatcher`, resolves
  `navigate(...)` targets relative to the current file, opens non-`.md`
  targets in the editor area via `vscode.window.showTextDocument`.
  Uses `vscode.workspace.fs.readFile` for files on disk and
  `TextDocument.getText()` for files open in editors so unsaved edits
  show up live.

- **`src/webview.ts`** — runs inside the webview iframe. Imports the
  full mermaid bundle (~2.9 MB minified). Receives `render` messages,
  parses the markdown via `parseMarkdown`, calls `mermaid.render()`,
  posts navigation events back to the extension. Browser target, IIFE
  format.

- **`src/protocol.ts`** — discriminated unions for messages in both
  directions (`ToWebview` / `FromWebview`). Both files import this so
  the contract stays in one place.

- **`src/parse.ts`** — `parseMarkdown`/`parseFrontmatter`. Pure,
  dependency-free, runs in both Node and the webview. The current
  parser is a CommonMark-ish line scanner (handles 3+ backticks or
  tildes, indented fences ≤3 spaces, info strings like `mermaid`,
  `Mermaid title="..."`, `{mermaid}`). Don't replace this with a single
  regex — the regex version regressed in two reported cases.

## Message protocol

Extension → webview:
- `render` — replace the panel contents with a parsed file
- `show-error` — toast a one-line error

Webview → extension:
- `ready` — webview script booted, safe to send `render`
- `navigate` — user clicked a `click ... call navigate("...")` node
- `back` / `pop-to` — breadcrumb navigation
- `reveal-source` — open the underlying `.md` in a normal editor

The extension defers the first `render` until it receives `ready` (see
`pendingRender` flag) — without this, messages can arrive before the
webview script attaches its listener.

## CSP

The CSP is in `getHtml()` in `src/extension.ts`. Mermaid needs:
- `script-src 'unsafe-eval'` (mermaid uses `Function`/`eval` at
  `securityLevel: 'loose'`, which is required for click handlers)
- `worker-src blob:` (some layouts spawn workers)
- `style-src 'unsafe-inline'` (mermaid injects inline styles into SVG)

If you tighten CSP, test that mermaid still renders before shipping —
silent rendering failures have happened twice when CSP was too strict.

## Webview error capture

`src/webview.ts` installs `window.addEventListener('error', ...)` and
`'unhandledrejection'` handlers that paint a fixed red banner at the
bottom of the page. Keep this — silent webview failures are otherwise
invisible without "Developer: Open Webview Developer Tools".

## Tests

`test/parse.test.ts` covers the parser. The `test/fixtures/overview.md`
file is a copy of the project's real example; the fixture test exists
specifically to regression-guard the user-reported failure where that
file was treated as having no mermaid block.

When adding parser features, add a test for the *failing* input first.

## File markup conventions (consumed, not authored, by this extension)

- One mermaid block per file (additional blocks render only the first)
- Frontmatter: `name`, `description`, `tags`
- Click handlers: `click NodeId call navigate("./relative/path")`
- Targets ending in `.md` open as another diagram (push breadcrumb);
  anything else opens in a normal editor tab

The example at `~/projects/codeswim-example` is the canonical reference.

## Don't

- Don't ship sourcemaps in the .vsix (`.vscodeignore` excludes
  `**/*.map`); they roughly double the package size.
- Don't add a "raw markdown" view — VS Code's text editor already does
  that, and the extension is meant to coexist with it side-by-side.
- Don't add a file tree, script runner, or breadcrumb history that
  spans non-md files. Those features belong in the standalone app at
  `~/projects/codeswim`; the extension intentionally delegates them to
  VS Code's built-in surfaces.
