---
name: Extension host
description: Node-hosted entry point. Registers commands, owns the webview panel lifecycle, watches the filesystem, and resolves navigate() targets.
tags: [extension-host, node]
---

# Extension host

Runs in VS Code's Node-hosted extension host. All filesystem and
workspace API access lives here — the webview side only sees parsed
content sent over `postMessage`.

```mermaid
flowchart TD
  activate["activate()<br/>command registration"]
  ensurePanel["ensurePanel()<br/>create / focus webview"]
  getHtml["getHtml()<br/>HTML shell + CSP"]
  watcher["setupWatcher()<br/>FileSystemWatcher"]
  navigate["handleNavigate()<br/>resolve target URI"]
  lineRange["parseLineRange()<br/>#L10-L22 fragments"]
  coverage["runCoverage()<br/>+ reportToOutput / populateDiagnostics"]
  proto["protocol.ts<br/>message types"]
  parse["parse.ts<br/>shared parser"]

  activate --> ensurePanel
  ensurePanel --> getHtml
  ensurePanel --> watcher
  ensurePanel --> navigate
  navigate --> lineRange
  activate --> coverage
  ensurePanel --- proto
  ensurePanel --- parse

  click activate call navigate("./src/extension.ts#L471-L499")
  click ensurePanel call navigate("./src/extension.ts#L404-L469")
  click getHtml call navigate("./src/extension.ts#L30-L75")
  click watcher call navigate("./src/extension.ts#L118-L138")
  click navigate call navigate("./src/extension.ts#L166-L204")
  click lineRange call navigate("./src/extension.ts#L150-L164")
  click coverage call navigate("./src/extension.ts#L249-L402")
  click proto call navigate("./src/protocol.ts")
  click parse call navigate("./src/parse.ts")
```

## Lifecycle in one paragraph

`activate()` registers the four commands (`showPreview`, `back`,
`revealSource`, `checkCoverage`). The first `showPreview` for a given
target creates the panel via `ensurePanel()`, which wires up the
filesystem watcher, sets the CSP HTML, and starts listening for
`FromWebview` messages. `handleNavigate()` translates a clicked node's
target into either a recursive diagram view (markdown without a line
range) or a `showTextDocument()` call with a selection range
(everything else). `runCoverage()` walks the workspace, feeds files
into `analyzeCoverage()`, and surfaces the result via the output
channel plus diagnostics.

## Related

- [src/webview.ts](./src/webview.ts) — what the host renders into.
- [coverage.md](./coverage.md) — the analyzer the host invokes.
