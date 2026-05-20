import mermaid from 'mermaid'
import { Crumb, FromWebview, ToWebview } from './protocol'
import { parseMarkdown } from './parse'

interface VSCodeApi {
  postMessage(msg: FromWebview): void
}

declare function acquireVsCodeApi(): VSCodeApi

const vscode = acquireVsCodeApi()

// Surface ANY unhandled error in a fixed banner at the bottom of the page so
// silent failures (mermaid, CSP, etc.) become visible without devtools.
function showFatalBanner(message: string): void {
  let banner = document.getElementById('__codeswim_fatal__')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = '__codeswim_fatal__'
    banner.style.cssText = [
      'position:fixed',
      'left:8px',
      'right:8px',
      'bottom:8px',
      'background:#82071e',
      'color:#fff',
      'padding:8px 12px',
      'border-radius:4px',
      'font:12px/1.4 var(--vscode-editor-font-family, monospace)',
      'white-space:pre-wrap',
      'z-index:9999',
      'max-height:40vh',
      'overflow:auto'
    ].join(';')
    document.body.appendChild(banner)
  }
  banner.textContent = (banner.textContent ? banner.textContent + '\n' : '') + message
}

window.addEventListener('error', (e) => {
  showFatalBanner(`error: ${e.message} @ ${e.filename}:${e.lineno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  showFatalBanner(`unhandled promise rejection: ${r instanceof Error ? r.stack ?? r.message : String(r)}`)
})

// VS Code paints the webview body with a theme-kind class. Match mermaid's
// theme to it so dark VS Code themes don't render black-on-black diagrams.
type ThemeKind = 'light' | 'dark' | 'hc-dark' | 'hc-light'

function detectThemeKind(): ThemeKind {
  const cls = document.body.classList
  if (cls.contains('vscode-high-contrast-light')) return 'hc-light'
  if (cls.contains('vscode-high-contrast')) return 'hc-dark'
  if (cls.contains('vscode-dark')) return 'dark'
  return 'light'
}

function mermaidThemeFor(kind: ThemeKind): 'default' | 'dark' {
  return kind === 'dark' || kind === 'hc-dark' ? 'dark' : 'default'
}

function initMermaid(): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: mermaidThemeFor(detectThemeKind()),
    fontFamily: 'inherit'
  })
}

initMermaid()

interface NavigateFn {
  (target: string): void
}

declare global {
  interface Window {
    navigate?: NavigateFn
  }
}

window.navigate = (target: string): void => {
  vscode.postMessage({ type: 'navigate', target })
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else e.setAttribute(k, v)
  }
  if (text !== undefined) e.textContent = text
  return e
}

function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function renderBreadcrumbs(parent: HTMLElement, crumbs: Crumb[], currentLabel: string): void {
  const wrap = el('div', { class: 'breadcrumbs' })
  crumbs.forEach((c, i) => {
    const btn = el('button', { class: 'crumb', title: c.key }, c.label)
    btn.addEventListener('click', () => vscode.postMessage({ type: 'pop-to', index: i }))
    wrap.appendChild(btn)
    wrap.appendChild(el('span', { class: 'sep' }, ' / '))
  })
  wrap.appendChild(el('span', { class: 'crumb current' }, currentLabel))
  parent.appendChild(wrap)
}

function renderHeader(crumbs: Crumb[], canGoBack: boolean, currentLabel: string): HTMLElement {
  const header = el('div', { class: 'header' })

  if (canGoBack) {
    const back = el('button', { class: 'btn ghost', title: 'Back' }, '← Back')
    back.addEventListener('click', () => vscode.postMessage({ type: 'back' }))
    header.appendChild(back)
  }

  renderBreadcrumbs(header, crumbs, currentLabel)

  const coverage = el(
    'button',
    { class: 'btn ghost', title: 'Check that all diagram links resolve and report orphaned files' },
    '✓ Check coverage'
  )
  coverage.addEventListener('click', () => vscode.postMessage({ type: 'check-coverage' }))
  header.appendChild(coverage)

  const reveal = el('button', { class: 'btn ghost', title: 'Reveal source' }, '⤴ Source')
  reveal.addEventListener('click', () => vscode.postMessage({ type: 'reveal-source' }))
  header.appendChild(reveal)

  return header
}

let renderSeq = 0

interface DiagramClickTarget {
  nodeId: string
  target: string
}

async function renderDiagram(host: HTMLElement, code: string): Promise<void> {
  renderSeq++
  const seq = renderSeq
  const id = `mermaid-${seq}`
  // Show "rendering…" immediately so the user knows we got to this code path.
  host.textContent = 'Rendering diagram…'
  try {
    const { svg, bindFunctions } = await mermaid.render(id, code)
    if (seq !== renderSeq) return
    if (!svg || svg.length === 0) {
      throw new Error('mermaid returned an empty SVG')
    }
    host.innerHTML = svg
    if (bindFunctions) bindFunctions(host)
    addDiagramTooltips(host, code)
  } catch (err) {
    if (seq !== renderSeq) return
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    host.innerHTML = ''
    const banner = el('div', { class: 'banner error' }, `Mermaid render error: ${msg}`)
    const pre = el('pre', { class: 'codeblock' }, code)
    host.appendChild(banner)
    host.appendChild(pre)
  }
}

function addDiagramTooltips(host: HTMLElement, code: string): void {
  const targets = extractDiagramClickTargets(code)
  if (targets.length === 0) return

  for (const target of targets) {
    for (const node of findDiagramNodes(host, target.nodeId)) {
      const message = `Open ${target.target}`
      node.setAttribute('data-codeswim-target', target.target)
      node.setAttribute('aria-label', message)
      node.setAttribute('tabindex', '0')

      const existing = Array.from(node.children).find(
        (child) => child.localName.toLowerCase() === 'title'
      )
      existing?.remove()

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = message
      node.insertBefore(title, node.firstChild)
    }
  }
}

function extractDiagramClickTargets(code: string): DiagramClickTarget[] {
  const targets: DiagramClickTarget[] = []
  const seen = new Set<string>()
  const re = /\bclick\s+(\S+)\s+call\s+navigate\(\s*(["'])(.*?)\2\s*\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    const nodeId = match[1]
    const target = match[3]
    const key = `${nodeId}\n${target}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ nodeId, target })
  }
  return targets
}

function findDiagramNodes(host: HTMLElement, nodeId: string): SVGElement[] {
  const candidates = Array.from(
    host.querySelectorAll<SVGElement>('.clickable, g.node, g[class*="node"]')
  )
  const exact = candidates.filter((node) => getMermaidNodeId(node) === nodeId)
  if (exact.length > 0) return exact

  const escaped = cssEscape(nodeId)
  return Array.from(
    host.querySelectorAll<SVGElement>(
      [
        `#${escaped}`,
        `[id^="flowchart-${escaped}-"]`,
        `[id^="state-${escaped}-"]`,
        `[id^="${escaped}-"]`,
        `[data-id="${escaped}"]`
      ].join(',')
    )
  )
}

function getMermaidNodeId(node: Element): string | null {
  const dataId = node.getAttribute('data-id')
  if (dataId) return dataId

  const id = node.id
  const flowchart = id.match(/^flowchart-(.+)-\d+$/)
  if (flowchart) return flowchart[1]
  const state = id.match(/^state-(.+)-\d+$/)
  if (state) return state[1]
  return id || null
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/["\\]/g, '\\$&')
}

function renderMarkdown(source: string): HTMLElement {
  const container = el('div', { class: 'prose' })
  const lines = source.split(/\r?\n/)
  let i = 0

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++
      continue
    }

    const heading = lines[i].match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      const node = el(`h${level}` as keyof HTMLElementTagNameMap)
      appendInline(node, heading[2].trim())
      container.appendChild(node)
      i++
      continue
    }

    const fence = lines[i].match(/^(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const fenceChar = fence[1][0]
      const minLength = fence[1].length
      const codeLines: string[] = []
      i++
      while (i < lines.length && !isMarkdownClosingFence(lines[i], fenceChar, minLength)) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      const pre = el('pre', { class: 'codeblock' })
      pre.appendChild(el('code', {}, codeLines.join('\n')))
      container.appendChild(pre)
      continue
    }

    const listItem = lines[i].match(/^\s*[-*]\s+(.+)$/)
    if (listItem) {
      const list = el('ul')
      while (i < lines.length) {
        const item = lines[i].match(/^\s*[-*]\s+(.+)$/)
        if (!item) break
        const li = el('li')
        appendInline(li, item[1])
        list.appendChild(li)
        i++
      }
      container.appendChild(list)
      continue
    }

    const paragraphLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^(`{3,}|~{3,})/.test(lines[i])
    ) {
      paragraphLines.push(lines[i].trim())
      i++
    }
    const p = el('p')
    appendInline(p, paragraphLines.join(' '))
    container.appendChild(p)
  }

  return container
}

function appendInline(parent: HTMLElement, source: string): void {
  let i = 0
  while (i < source.length) {
    if (source.startsWith('`', i)) {
      const end = source.indexOf('`', i + 1)
      if (end > i) {
        parent.appendChild(el('code', {}, source.slice(i + 1, end)))
        i = end + 1
        continue
      }
    }

    if (source.startsWith('**', i) || source.startsWith('__', i)) {
      const marker = source.slice(i, i + 2)
      const end = source.indexOf(marker, i + 2)
      if (end > i) {
        const strong = el('strong')
        appendInline(strong, source.slice(i + 2, end))
        parent.appendChild(strong)
        i = end + 2
        continue
      }
    }

    if (source.startsWith('[', i)) {
      const labelEnd = source.indexOf('](', i + 1)
      const targetEnd = labelEnd >= 0 ? source.indexOf(')', labelEnd + 2) : -1
      if (labelEnd > i && targetEnd > labelEnd) {
        const label = source.slice(i + 1, labelEnd)
        const target = source.slice(labelEnd + 2, targetEnd)
        const link = el('a', { href: target, title: target })
        appendInline(link, label)
        link.addEventListener('click', (event) => {
          if (isWorkspaceLink(target)) {
            event.preventDefault()
            vscode.postMessage({ type: 'navigate', target })
          }
        })
        parent.appendChild(link)
        i = targetEnd + 1
        continue
      }
    }

    if (source.startsWith('*', i) || source.startsWith('_', i)) {
      const marker = source[i]
      const end = source.indexOf(marker, i + 1)
      if (end > i + 1) {
        const em = el('em')
        appendInline(em, source.slice(i + 1, end))
        parent.appendChild(em)
        i = end + 1
        continue
      }
    }

    const next = nextInlineMarker(source, i + 1)
    parent.appendChild(document.createTextNode(source.slice(i, next)))
    i = next
  }
}

function nextInlineMarker(source: string, start: number): number {
  const markers = ['`', '*', '_', '[']
  const positions = markers
    .map((marker) => source.indexOf(marker, start))
    .filter((position) => position >= 0)
  return positions.length > 0 ? Math.min(...positions) : source.length
}

function isMarkdownClosingFence(line: string, fenceChar: string, minLength: number): boolean {
  const match = line.match(fenceChar === '`' ? /^(`+)\s*$/ : /^(~+)\s*$/)
  return !!match && match[1].length >= minLength
}

function isWorkspaceLink(target: string): boolean {
  return !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('#')
}

let lastRender: Extract<ToWebview, { type: 'render' }> | null = null
let currentThemeKind = detectThemeKind()

new MutationObserver(() => {
  const next = detectThemeKind()
  if (next === currentThemeKind) return
  currentThemeKind = next
  initMermaid()
  if (lastRender) render(lastRender)
}).observe(document.body, { attributes: true, attributeFilter: ['class'] })

function render(msg: Extract<ToWebview, { type: 'render' }>): void {
  lastRender = msg
  const root = document.getElementById('root')!
  clear(root)

  const parsed = parseMarkdown(msg.file.content)
  const fm = parsed.frontmatter
  const fileLabel = fm.name ?? msg.file.name.replace(/\.md$/i, '')

  root.appendChild(renderHeader(msg.breadcrumbs, msg.canGoBack, fileLabel))

  const main = el('div', { class: 'main' })
  root.appendChild(main)

  const meta = el('div', { class: 'meta' })
  if (fm.description) {
    meta.appendChild(el('p', { class: 'desc' }, fm.description))
  }
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    const tagWrap = el('div', { class: 'tags' })
    for (const tag of fm.tags) tagWrap.appendChild(el('span', { class: 'tag' }, tag))
    meta.appendChild(tagWrap)
  }
  if (meta.children.length > 0) main.appendChild(meta)

  if (parsed.mermaidBlocks.length === 0) {
    const banner = el(
      'div',
      { class: 'banner warning' },
      `No mermaid code block found in ${msg.file.name} (${msg.file.content.length} bytes received).`
    )
    main.appendChild(banner)
    // Diagnostic: show the first 240 chars verbatim so we can see what
    // the webview actually got vs what's on disk.
    const hint = el('pre', { class: 'codeblock' }, msg.file.content.slice(0, 240))
    main.appendChild(hint)
  } else if (parsed.mermaidBlocks.length > 1) {
    main.appendChild(
      el(
        'div',
        { class: 'banner warning' },
        `${parsed.mermaidBlocks.length} mermaid blocks; rendering only the first.`
      )
    )
  }

  let renderedMermaid = false
  for (const section of parsed.sections) {
    if (section.type === 'markdown') {
      main.appendChild(renderMarkdown(section.content))
    } else if (!renderedMermaid) {
      const canvas = el('div', { class: 'canvas' })
      main.appendChild(canvas)
      void renderDiagram(canvas, section.content)
      renderedMermaid = true
    }
  }
}

function showError(message: string): void {
  const root = document.getElementById('root')!
  const existing = root.querySelector('.toast')
  existing?.remove()
  const toast = el('div', { class: 'toast' }, message)
  root.appendChild(toast)
  setTimeout(() => toast.remove(), 4000)
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const msg = e.data
  if (msg.type === 'render') render(msg)
  else if (msg.type === 'show-error') showError(msg.message)
})

vscode.postMessage({ type: 'ready' })
