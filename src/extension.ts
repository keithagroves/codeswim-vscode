import * as vscode from 'vscode'
import * as path from 'path'
import { Crumb, FromWebview, ToWebview } from './protocol'
import {
  analyzeCoverage,
  defaultIgnore,
  defaultIsDiagram,
  defaultIsSourceFile,
  type FileInfo,
  type CoverageReport
} from './coverage'
import { compileIgnore, parseIgnore } from './codeswim-ignore'
import { CodeswimTreeProvider } from './treeView'

interface PreviewState {
  panel: vscode.WebviewPanel
  current: vscode.Uri
  crumbs: vscode.Uri[] // history; current is NOT included
  ready: boolean
  pendingRender: boolean
  watcher: vscode.FileSystemWatcher | null
}

let active: PreviewState | null = null
let extensionUri: vscode.Uri
let diagnostics: vscode.DiagnosticCollection | null = null
let outputChannel: vscode.OutputChannel | null = null

function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

function getHtml(webview: vscode.Webview): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')
  )
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.css')
  )
  const n = nonce()
  // Note on the directives below:
  // - `script-src` allows our bundle (via nonce) and 'unsafe-eval' (mermaid
  //   uses Function/eval at runtime when securityLevel: 'loose').
  // - `worker-src blob:` covers mermaid layouts that spin up workers.
  // - `connect-src` is permissive because some mermaid features fetch
  //   layout helpers; restricting this caused silent render failures.
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}' 'unsafe-eval' 'unsafe-inline'`,
    `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource} blob: data:`,
    `img-src ${webview.cspSource} data: blob:`,
    `font-src ${webview.cspSource} data:`
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Diagram</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`
}

async function readFile(uri: vscode.Uri): Promise<string> {
  // Prefer an open document so unsaved edits show up.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
  if (open) return open.getText()
  const bytes = await vscode.workspace.fs.readFile(uri)
  return new TextDecoder('utf-8').decode(bytes)
}

function workspaceFolderOf(uri: vscode.Uri): vscode.WorkspaceFolder | null {
  return vscode.workspace.getWorkspaceFolder(uri) ?? null
}

function makeCrumbs(state: PreviewState): Crumb[] {
  return state.crumbs.map((u) => ({ label: labelFor(u), key: u.toString() }))
}

function labelFor(uri: vscode.Uri): string {
  const base = path.basename(uri.fsPath)
  return base.replace(/\.md$/i, '')
}

async function send(state: PreviewState, msg: ToWebview): Promise<void> {
  await state.panel.webview.postMessage(msg)
}

async function renderCurrent(state: PreviewState): Promise<void> {
  if (!state.ready) {
    state.pendingRender = true
    return
  }
  state.pendingRender = false
  try {
    const content = await readFile(state.current)
    await send(state, {
      type: 'render',
      file: {
        name: path.basename(state.current.fsPath),
        content,
        path: state.current.fsPath
      },
      breadcrumbs: makeCrumbs(state),
      canGoBack: state.crumbs.length > 0
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await send(state, { type: 'show-error', message: `Could not read file: ${message}` })
  }
}

function setupWatcher(state: PreviewState): void {
  state.watcher?.dispose()
  state.watcher = null

  const folder = workspaceFolderOf(state.current)
  if (!folder) return
  // Watch the entire workspace folder; we filter by current file when events arrive.
  // Cheap because chokidar/native watchers handle this efficiently.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '**/*')
  )
  const onChange = (uri: vscode.Uri): void => {
    if (uri.toString() === state.current.toString()) {
      void renderCurrent(state)
    }
  }
  watcher.onDidChange(onChange)
  watcher.onDidCreate(onChange)
  watcher.onDidDelete(onChange)
  state.watcher = watcher
}

async function navigateTo(state: PreviewState, target: vscode.Uri, push: boolean): Promise<void> {
  if (push) state.crumbs.push(state.current)
  state.current = target
  state.panel.title = `Diagram: ${labelFor(target)}`
  setupWatcher(state)
  await renderCurrent(state)
}

// GitHub-style line refs: #L10, #L10-L22, #L10-22. Returns null for any
// other fragment (anchor, malformed) so we silently open at the top.
const LINE_REF_RE = /^L(\d+)(?:-L?(\d+))?$/i

function parseLineRange(fragment: string): { start: number; end: number } | null {
  const m = fragment.match(LINE_REF_RE)
  if (!m) return null
  const start = Number.parseInt(m[1], 10)
  if (!Number.isFinite(start) || start < 1) return null
  const rawEnd = m[2] !== undefined ? Number.parseInt(m[2], 10) : start
  const end = Number.isFinite(rawEnd) && rawEnd >= start ? rawEnd : start
  return { start, end }
}

function rangeFromLines(lines: { start: number; end: number }): vscode.Range {
  return new vscode.Range(lines.start - 1, 0, lines.end - 1, Number.MAX_SAFE_INTEGER)
}

async function handleNavigate(state: PreviewState, raw: string): Promise<void> {
  // Resolve relative to the directory of the current file.
  const hashIdx = raw.indexOf('#')
  const pathPart = hashIdx < 0 ? raw : raw.slice(0, hashIdx)
  const fragment = hashIdx < 0 ? '' : raw.slice(hashIdx + 1)
  const cleaned = pathPart.split('?')[0]
  const lineRange = fragment ? parseLineRange(fragment) : null
  const baseDir = path.dirname(state.current.fsPath)
  const resolved = path.resolve(baseDir, cleaned)
  const targetUri = vscode.Uri.file(resolved)

  let stat: vscode.FileStat
  try {
    stat = await vscode.workspace.fs.stat(targetUri)
  } catch {
    await send(state, { type: 'show-error', message: `Not found: ${cleaned}` })
    return
  }
  if (stat.type === vscode.FileType.Directory) {
    await send(state, { type: 'show-error', message: `Cannot open directory: ${cleaned}` })
    return
  }

  const ext = path.extname(targetUri.fsPath).toLowerCase()
  const isMarkdown = ext === '.md' || ext === '.markdown'

  // A line ref only makes sense in source view, so a markdown target with a
  // range opens as text rather than as a new diagram webview.
  if (isMarkdown && !lineRange) {
    await navigateTo(state, targetUri, true)
    return
  }

  await vscode.window.showTextDocument(targetUri, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: false,
    selection: lineRange ? rangeFromLines(lineRange) : undefined
  })
}

async function handleMessage(state: PreviewState, msg: FromWebview): Promise<void> {
  switch (msg.type) {
    case 'ready':
      state.ready = true
      if (state.pendingRender) await renderCurrent(state)
      return
    case 'navigate':
      await handleNavigate(state, msg.target)
      return
    case 'back': {
      const prev = state.crumbs.pop()
      if (!prev) return
      state.current = prev
      state.panel.title = `Diagram: ${labelFor(prev)}`
      setupWatcher(state)
      await renderCurrent(state)
      return
    }
    case 'pop-to': {
      const idx = msg.index
      if (idx < 0 || idx >= state.crumbs.length) return
      const target = state.crumbs[idx]
      state.crumbs = state.crumbs.slice(0, idx)
      state.current = target
      state.panel.title = `Diagram: ${labelFor(target)}`
      setupWatcher(state)
      await renderCurrent(state)
      return
    }
    case 'reveal-source':
      await vscode.window.showTextDocument(state.current, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false
      })
      return
    case 'check-coverage':
      await runCoverage()
      return
  }
}

const COVERAGE_EXCLUDE = '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/.git/**,**/.vscode/**,**/*.vsix}'

function pickWorkspaceFolder(): vscode.WorkspaceFolder | null {
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active.current)
    if (f) return f
  }
  return vscode.workspace.workspaceFolders?.[0] ?? null
}

async function collectFiles(folder: vscode.WorkspaceFolder): Promise<FileInfo[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*'),
    COVERAGE_EXCLUDE
  )
  const decoder = new TextDecoder('utf-8')
  const out: FileInfo[] = []
  await Promise.all(
    uris.map(async (uri) => {
      const rel = path.posix.relative(
        folder.uri.path.replace(/\\/g, '/'),
        uri.path.replace(/\\/g, '/')
      )
      // Only read file types we care about. Reading every file in a large
      // repo is wasteful and binary files will throw on UTF-8 decode.
      if (!defaultIsDiagram(rel) && !defaultIsSourceFile(rel)) return
      try {
        const bytes = await vscode.workspace.fs.readFile(uri)
        out.push({ path: rel, content: decoder.decode(bytes) })
      } catch {
        // Skip unreadable files; coverage just won't include them.
      }
    })
  )
  return out
}

function reportToOutput(folder: vscode.WorkspaceFolder, report: CoverageReport): void {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Diagram Coverage')
  const ch = outputChannel
  ch.clear()
  ch.appendLine(`Diagram coverage for ${folder.name}`)
  ch.appendLine(`  Entry: ${report.entry ?? '(none — no markdown found)'}`)
  ch.appendLine('')
  ch.appendLine(
    `Diagrams:           ${report.totals.diagrams}` +
      `   (orphan: ${report.orphanDiagrams.length})`
  )
  ch.appendLine(
    `Source files:       ${report.totals.sources}` +
      `   (covered: ${report.totals.coveredSources}, uncovered: ${report.uncoveredSources.length})`
  )
  ch.appendLine(
    `Links checked:      ${report.totals.totalLinks}` +
      `   (broken: ${report.totals.brokenLinkCount})`
  )
  ch.appendLine('')

  if (report.brokenLinks.length > 0) {
    ch.appendLine('Broken links:')
    for (const b of report.brokenLinks) {
      ch.appendLine(`  ${b.sourceFile}:${b.line}:${b.column}  ${b.kind}("${b.target}")`)
    }
    ch.appendLine('')
  }
  if (report.orphanDiagrams.length > 0) {
    ch.appendLine('Orphan diagrams (not reachable from entry):')
    for (const o of report.orphanDiagrams) ch.appendLine(`  ${o}`)
    ch.appendLine('')
  }
  if (report.uncoveredSources.length > 0) {
    ch.appendLine('Source files referenced by no diagram:')
    for (const s of report.uncoveredSources) ch.appendLine(`  ${s}`)
    ch.appendLine('')
  }
  if (
    report.brokenLinks.length === 0 &&
    report.orphanDiagrams.length === 0 &&
    report.uncoveredSources.length === 0
  ) {
    ch.appendLine('All checks passed — diagrams are aligned with the codebase.')
  }
  ch.show(true)
}

function populateDiagnostics(
  folder: vscode.WorkspaceFolder,
  report: CoverageReport
): void {
  if (!diagnostics) diagnostics = vscode.languages.createDiagnosticCollection('codeswim')
  diagnostics.clear()

  const byFile = new Map<string, vscode.Diagnostic[]>()
  const push = (relPath: string, d: vscode.Diagnostic): void => {
    const arr = byFile.get(relPath) ?? []
    arr.push(d)
    byFile.set(relPath, arr)
  }

  for (const b of report.brokenLinks) {
    const start = new vscode.Position(b.line - 1, b.column - 1)
    const end = new vscode.Position(b.line - 1, b.column - 1 + b.target.length)
    const d = new vscode.Diagnostic(
      new vscode.Range(start, end),
      `Broken link: ${b.target}`,
      vscode.DiagnosticSeverity.Error
    )
    d.source = 'codeswim'
    push(b.sourceFile, d)
  }

  for (const o of report.orphanDiagrams) {
    const d = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      `Orphan diagram: not reachable from ${report.entry ?? 'the entry diagram'}`,
      vscode.DiagnosticSeverity.Warning
    )
    d.source = 'codeswim'
    push(o, d)
  }

  for (const [rel, diags] of byFile) {
    diagnostics.set(vscode.Uri.joinPath(folder.uri, rel), diags)
  }
}

async function loadProjectIgnore(folder: vscode.WorkspaceFolder): Promise<(path: string) => boolean> {
  const uri = vscode.Uri.joinPath(folder.uri, '.codeswimignore')
  try {
    const bytes = await vscode.workspace.fs.readFile(uri)
    const text = new TextDecoder('utf-8').decode(bytes)
    return compileIgnore(parseIgnore(text))
  } catch {
    return () => false
  }
}

async function runCoverage(): Promise<void> {
  const folder = pickWorkspaceFolder()
  if (!folder) {
    void vscode.window.showInformationMessage(
      'codeswim: open a folder before running coverage.'
    )
    return
  }
  const userIgnore = await loadProjectIgnore(folder)
  const ignore = (p: string): boolean => defaultIgnore(p) || userIgnore(p)
  const files = await collectFiles(folder)
  const report = analyzeCoverage(files, { ignore })
  populateDiagnostics(folder, report)
  reportToOutput(folder, report)

  // Quick toast summary so the user gets immediate feedback even if Problems
  // and Output panels are closed.
  const summary =
    `${report.totals.totalLinks} links · ` +
    `${report.totals.brokenLinkCount} broken · ` +
    `${report.orphanDiagrams.length} orphan diagrams · ` +
    `${report.uncoveredSources.length}/${report.totals.sources} sources uncovered`
  if (
    report.totals.brokenLinkCount === 0 &&
    report.orphanDiagrams.length === 0 &&
    report.uncoveredSources.length === 0
  ) {
    void vscode.window.showInformationMessage(`Diagram coverage: ${summary}`)
  } else {
    void vscode.window.showWarningMessage(`Diagram coverage: ${summary}`)
  }
}

function ensurePanel(target: vscode.Uri): PreviewState {
  // If a panel already exists, navigate it to the new file (push to history)
  // rather than spawning a second panel.
  if (active && active.panel.webview && !active.panel.visible === false) {
    void navigateTo(active, target, true)
    active.panel.reveal(active.panel.viewColumn ?? vscode.ViewColumn.Two, false)
    return active
  }

  const panel = vscode.window.createWebviewPanel(
    'codeswim.diagram',
    `Diagram: ${labelFor(target)}`,
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    }
  )

  const state: PreviewState = {
    panel,
    current: target,
    crumbs: [],
    ready: false,
    pendingRender: false,
    watcher: null
  }
  active = state

  panel.webview.html = getHtml(panel.webview)
  panel.webview.onDidReceiveMessage((msg: FromWebview) => {
    void handleMessage(state, msg)
  })
  panel.onDidDispose(() => {
    state.watcher?.dispose()
    if (active === state) active = null
  })

  setupWatcher(state)
  return state
}

async function showPreview(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri
  if (!target) {
    void vscode.window.showInformationMessage(
      'Open a markdown file first, or run this from the file context menu.'
    )
    return
  }
  const ext = path.extname(target.fsPath).toLowerCase()
  if (ext !== '.md' && ext !== '.markdown') {
    void vscode.window.showInformationMessage('codeswim only opens markdown files.')
    return
  }

  const state = ensurePanel(target)
  // ensurePanel handles existing-panel navigation; for a fresh panel we need
  // to render once the webview signals ready.
  if (state.current.toString() !== target.toString()) {
    await navigateTo(state, target, false)
  } else {
    await renderCurrent(state)
  }
}

async function overviewUri(): Promise<vscode.Uri | null> {
  const folder = pickWorkspaceFolder()
  if (!folder) return null
  return vscode.Uri.joinPath(folder.uri, 'overview.md')
}

async function updateOverviewContext(): Promise<void> {
  const uri = await overviewUri()
  let has = false
  if (uri) {
    try {
      await vscode.workspace.fs.stat(uri)
      has = true
    } catch {
      /* no overview */
    }
  }
  await vscode.commands.executeCommand('setContext', 'codeswim.hasOverview', has)
}

const OVERVIEW_TEMPLATE = `---
name: overview
description: Entry diagram for this project.
tags: [overview]
---

# Overview

\`\`\`mermaid
graph TD
  Start[Project root]
  click Start call navigate("./README.md")
\`\`\`
`

export function activate(ctx: vscode.ExtensionContext): void {
  extensionUri = ctx.extensionUri

  const treeProvider = new CodeswimTreeProvider(() => pickWorkspaceFolder())

  ctx.subscriptions.push(
    vscode.commands.registerCommand('codeswim.showPreview', showPreview),
    vscode.commands.registerCommand('codeswim.back', () => {
      if (!active) return
      void handleMessage(active, { type: 'back' })
    }),
    vscode.commands.registerCommand('codeswim.revealSource', () => {
      if (!active) return
      void handleMessage(active, { type: 'reveal-source' })
    }),
    vscode.commands.registerCommand('codeswim.checkCoverage', () => {
      void runCoverage()
    }),
    vscode.commands.registerCommand('codeswim.openOverview', async () => {
      const uri = await overviewUri()
      if (!uri) {
        void vscode.window.showInformationMessage('codeswim: open a folder first.')
        return
      }
      await showPreview(uri)
    }),
    vscode.commands.registerCommand('codeswim.createOverview', async () => {
      const uri = await overviewUri()
      if (!uri) {
        void vscode.window.showInformationMessage('codeswim: open a folder first.')
        return
      }
      try {
        await vscode.workspace.fs.stat(uri)
      } catch {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(OVERVIEW_TEMPLATE))
      }
      await updateOverviewContext()
      treeProvider.refresh()
      await showPreview(uri)
    }),
    vscode.commands.registerCommand('codeswim.refreshTree', () => {
      void updateOverviewContext()
      treeProvider.refresh()
    }),
    vscode.window.registerTreeDataProvider('codeswim.diagrams', treeProvider)
  )

  // Re-render when the user saves an open document we're currently displaying,
  // so unsaved edits also show via onDidChangeTextDocument below.
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!active) return
      if (e.document.uri.toString() === active.current.toString()) {
        void renderCurrent(active)
      }
    })
  )

  // Keep the welcome-view vs. tree toggle and the tree contents in sync with
  // overview.md and any reachable diagram churn. Watching **/*.md is broad but
  // cheap, and avoids us missing edits to non-overview diagrams that change
  // the reachable graph.
  const mdWatcher = vscode.workspace.createFileSystemWatcher('**/*.md')
  const onOverviewMaybeChanged = (uri: vscode.Uri): void => {
    if (path.basename(uri.fsPath).toLowerCase() === 'overview.md') {
      void updateOverviewContext()
    }
    treeProvider.refresh()
  }
  ctx.subscriptions.push(
    mdWatcher,
    mdWatcher.onDidCreate(onOverviewMaybeChanged),
    mdWatcher.onDidDelete(onOverviewMaybeChanged),
    mdWatcher.onDidChange(onOverviewMaybeChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateOverviewContext()
      treeProvider.refresh()
    })
  )
  void updateOverviewContext()
}

export function deactivate(): void {
  active?.watcher?.dispose()
  active?.panel.dispose()
  active = null
  diagnostics?.dispose()
  diagnostics = null
  outputChannel?.dispose()
  outputChannel = null
}
