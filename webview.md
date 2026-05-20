---
name: Webview iframe
description: Browser-target entry point. Loads mermaid, renders the parsed file, posts navigation events back to the extension host.
tags: [webview, browser]
---

# Webview iframe

Runs inside the webview's sandboxed iframe with a strict CSP. Imports
the full mermaid bundle (~2.9 MB minified). All filesystem access is
delegated to the extension host — this side only sees content shipped
over `postMessage`.

```mermaid
flowchart TD
  init["initMermaid()<br/>theme + securityLevel"]
  detect["detectThemeKind()<br/>vscode-dark / hc / light"]
  observer["MutationObserver<br/>re-init on theme toggle"]
  render["render()<br/>main render loop"]
  header["renderHeader()<br/>breadcrumbs + back"]
  markdown["renderMarkdown()<br/>CommonMark-ish"]
  clicks["extractDiagramClickTargets<br/>+ findDiagramNodes"]
  fatal["showFatalBanner()<br/>error capture"]
  proto["protocol.ts<br/>shared message types"]
  parse["parse.ts<br/>shared parser"]
  css["webview.css"]

  init --> detect
  observer --> init
  observer --> render
  render --> header
  render --> markdown
  render --> clicks
  init -.->|on error| fatal
  render --- proto
  render --- parse
  render --- css

  click init call navigate("./src/webview.ts#L64-L73")
  click detect call navigate("./src/webview.ts#L50-L62")
  click observer call navigate("./src/webview.ts#L410-L417")
  click render call navigate("./src/webview.ts#L419-L476")
  click header call navigate("./src/webview.ts#L107-L176")
  click markdown call navigate("./src/webview.ts#L257-L327")
  click clicks call navigate("./src/webview.ts#L178-L255")
  click fatal call navigate("./src/webview.ts#L15-L46")
  click proto call navigate("./src/protocol.ts")
  click parse call navigate("./src/parse.ts")
  click css call navigate("./media/webview.css")
```

## Dark mode

`detectThemeKind()` reads `document.body.classList` for the
`vscode-dark` / `vscode-high-contrast` markers VS Code injects.
`mermaidThemeFor()` picks `'dark'` for dark/HC-dark and `'default'`
for everything else. A `MutationObserver` watches `body.class`; when
the user swaps themes the diagram re-renders with the saved
`lastRender` payload — no extension-host round-trip needed.

## Error capture

`window.error` and `unhandledrejection` paint a fixed red banner at the
bottom of the page. Without this, silent mermaid failures look like a
blank webview (`CLAUDE.md` calls this out specifically).
