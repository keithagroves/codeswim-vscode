// Heuristic mermaid linter. Mirrors the validator in codeswim's harness
// plugin (src/harness/tool/diagram-edit.ts) — keep the two in sync.
//
// Catches the specific failure patterns we've seen in practice:
//   - `click ... call navigate(...)` inside non-flowchart diagrams (which
//     mermaid's parser rejects with a cryptic "Expecting SOLID_ARROW…" error)
//   - `{...}` shape tokens inside an unquoted `[...]` node label (mermaid
//     misreads it as the start of a diamond shape mid-bracket)
//   - Malformed line refs in navigate targets — `#Lfoo`, `#L0`, reversed
//     ranges like `#L20-L5`. These silently no-op at navigate time (file
//     opens at the top), so a lint warning is the only visible signal.
//   - Flowchart nodes with no `click ... call navigate(...)` handler. The
//     codeswim convention is that every node should be navigable.
//
// Not a full parse — that needs the mermaid runtime + DOM. This catches
// the bugs the agent actually generates, with zero new dependencies.

import type { FileInfo } from './coverage'

export interface MermaidIssue {
  sourceFile: string
  line: number // 1-indexed, relative to the file
  message: string
}

const NON_FLOWCHART_TYPES = new Set([
  'sequencediagram',
  'classdiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'mindmap',
  'gantt',
  'pie',
  'journey',
  'requirementdiagram',
  'timeline',
  'gitgraph',
  'sankey-beta',
  'sankey',
  'quadrantchart',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'kanban',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
  'c4deployment',
  'architecture-beta'
])

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/

interface MermaidBlock {
  source: string
  startLine: number // 1-indexed line in the file of the first content line
}

function extractMermaidBlocks(file: FileInfo): MermaidBlock[] {
  const lines = file.content.split(/\r?\n/)
  const blocks: MermaidBlock[] = []
  let fenceChar: string | null = null
  let fenceLength = 0
  let inMermaid = false
  let buf: string[] = []
  let blockStart = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(FENCE_OPEN_RE)
    if (m) {
      const seq = m[2]
      const ch = seq[0]
      const len = seq.length
      if (fenceChar === null) {
        fenceChar = ch
        fenceLength = len
        const info = m[3].trim().toLowerCase().split(/\s+/)[0]
        inMermaid = info === 'mermaid' || info === '{mermaid}' || info.startsWith('{mermaid,')
        buf = []
        blockStart = i + 2 // first content line after the fence
        continue
      } else if (ch === fenceChar && len >= fenceLength && m[3].trim() === '') {
        if (inMermaid) blocks.push({ source: buf.join('\n'), startLine: blockStart })
        fenceChar = null
        fenceLength = 0
        inMermaid = false
        buf = []
        continue
      }
    }
    if (inMermaid) buf.push(line)
  }
  return blocks
}

function detectDiagramType(source: string): string {
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    return line.split(/\s+/)[0].toLowerCase()
  }
  return ''
}

const NAVIGATE_RE = /\bnavigate\(\s*"([^"\n]+)"\s*\)/g

// A node definition: `<ID><shape>`. The shape variants below are listed
// longest-first so e.g. `[[...]]` is matched before plain `[...]`.
const NODE_DEF_RE =
  /\b([A-Za-z_][A-Za-z0-9_-]*)(\[\[[^\]\n]*\]\]|\[\([^)\n]*\)\]|\[\/[^/\n]*\/\]|\[\\[^\\\n]*\\\]|\(\(\([^)\n]*\)\)\)|\(\([^)\n]*\)\)|\{\{[^}\n]*\}\}|\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\}|>[^\]\n]*\])/g

// An edge of the form `<ID> <connector> <ID>`, optionally with inline edge
// text (`A -- text --> B`). Captures both endpoints. After each match we
// rewind lastIndex to the start of the second ID — that lets `A --> B --> C`
// re-match starting at B, while preventing the regex from matching suffixes
// of identifiers (`lient --> API` inside `Client --> API`) or inline-edge
// words (`HTTP --> B` inside `A -- HTTP --> B`).
const EDGE_RE =
  /\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?:[-=.]{2,}\s+[^-=.>|<\n]+?\s+)?[-=.]{2,}[->ox]?\s*([A-Za-z_][A-Za-z0-9_-]*)/g

const CLICK_TARGET_RE = /^\s*click\s+([A-Za-z0-9_-]+)\s+call\s+navigate\(/

// Lines starting with these tokens don't introduce nodes — skip them.
const NODE_SKIP_PREFIXES = [
  'subgraph',
  'end',
  'click',
  'style',
  'classDef',
  'class',
  'linkStyle',
  'direction',
  'title',
  '%%'
]

// Tokens that look like identifiers but appear in non-node positions and
// would produce false positives if treated as node names.
const NODE_NAME_DENY = new Set(['TD', 'TB', 'BT', 'LR', 'RL'])

function stripShapeContents(line: string): string {
  let prev = ''
  let s = line
  while (prev !== s) {
    prev = s
    s = s
      .replace(/\[\[[^\]\n]*\]\]/g, ' ')
      .replace(/\[\([^)\n]*\)\]/g, ' ')
      .replace(/\[\/[^/\n]*\/\]/g, ' ')
      .replace(/\[\\[^\\\n]*\\\]/g, ' ')
      .replace(/\(\(\([^)\n]*\)\)\)/g, ' ')
      .replace(/\(\([^)\n]*\)\)/g, ' ')
      .replace(/\{\{[^}\n]*\}\}/g, ' ')
      .replace(/\[[^\]\n]*\]/g, ' ')
      .replace(/\([^)\n]*\)/g, ' ')
      .replace(/\{[^}\n]*\}/g, ' ')
      .replace(/>[^\]\n]*\]/g, ' ')
  }
  return s
}

function isNodeBearingLine(trimmed: string): boolean {
  if (!trimmed) return false
  if (trimmed === 'end') return false
  for (const prefix of NODE_SKIP_PREFIXES) {
    if (trimmed === prefix) return false
    if (trimmed.startsWith(prefix + ' ') || trimmed.startsWith(prefix + '\t')) return false
  }
  return true
}

// Find every flowchart node (by ID) in the block and remember the
// 0-indexed line where it first appears. `&` shorthand chains
// (`A & B --> C`) are not fully handled — false negatives there are
// acceptable since they're rare; false positives are not.
function extractFlowchartNodes(source: string): Map<string, number> {
  const nodes = new Map<string, number>()
  const lines = source.split(/\r?\n/)
  let seenType = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('%%')) continue
    if (!seenType) {
      // First non-comment line is the diagram type declaration.
      seenType = true
      continue
    }
    if (!isNodeBearingLine(trimmed)) continue

    NODE_DEF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = NODE_DEF_RE.exec(raw)) !== null) {
      const id = m[1]
      if (NODE_NAME_DENY.has(id)) continue
      if (!nodes.has(id)) nodes.set(id, i)
    }

    const stripped = stripShapeContents(raw).replace(/\|[^|\n]*\|/g, ' ')
    EDGE_RE.lastIndex = 0
    while ((m = EDGE_RE.exec(stripped)) !== null) {
      const a = m[1]
      const b = m[2]
      if (!NODE_NAME_DENY.has(a) && !nodes.has(a)) nodes.set(a, i)
      if (!NODE_NAME_DENY.has(b) && !nodes.has(b)) nodes.set(b, i)
      // Rewind to the start of the second ID so chained edges re-match
      // there but suffixes / inline-edge-text identifiers are skipped past.
      EDGE_RE.lastIndex = m.index + m[0].length - b.length
    }
  }
  return nodes
}

function extractClickedNodes(source: string): Set<string> {
  const clicks = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(CLICK_TARGET_RE)
    if (m) clicks.add(m[1])
  }
  return clicks
}

// In a navigate(...) target, the fragment (anything after #) is by
// convention a GitHub-style line ref. Returns a one-line problem string,
// or null if the fragment is missing or well-formed.
export function checkLineRef(target: string): string | null {
  const hashIdx = target.indexOf('#')
  if (hashIdx < 0) return null
  const frag = target.slice(hashIdx + 1).split('?')[0]
  if (!frag) return null
  const m = frag.match(/^L(\d+)(?:-L?(\d+))?$/i)
  if (!m) {
    return (
      `navigate target has invalid line ref \`#${frag}\` — expected \`#L10\`, \`#L10-L22\`, or \`#L10-22\`.`
    )
  }
  const start = Number.parseInt(m[1], 10)
  if (start < 1) {
    return `navigate target \`#${frag}\` uses line ${start} — line numbers are 1-indexed.`
  }
  if (m[2] !== undefined) {
    const end = Number.parseInt(m[2], 10)
    if (end < start) {
      return `navigate target \`#${frag}\` has a reversed range (end ${end} < start ${start}).`
    }
  }
  return null
}

function lintBlock(file: FileInfo, block: MermaidBlock): MermaidIssue[] {
  const issues: MermaidIssue[] = []
  const type = detectDiagramType(block.source)
  if (!type) return issues

  const lines = block.source.split(/\r?\n/)
  const clickRe = /^\s*click\s+[A-Za-z0-9_-]+\s+call\s+navigate\(/

  if (NON_FLOWCHART_TYPES.has(type)) {
    for (let i = 0; i < lines.length; i++) {
      if (clickRe.test(lines[i])) {
        issues.push({
          sourceFile: file.path,
          line: block.startLine + i,
          message:
            `\`click ... call navigate(...)\` is flowchart-only — \`${type}\` does not support it. ` +
            `Move navigation to a prose bullet list under the mermaid block.`
        })
      }
    }
  } else {
    const labelRe = /\[([^\]\n]*)\]/g
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      labelRe.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = labelRe.exec(line)) !== null) {
        const inner = m[1]
        const trimmed = inner.trim()
        const isQuoted =
          (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
          (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2)
        if (!isQuoted && inner.includes('{')) {
          issues.push({
            sourceFile: file.path,
            line: block.startLine + i,
            message:
              `unquoted square-bracket label contains \`{\` — mermaid parses it as a diamond start. ` +
              `Quote the label: \`["${inner.replace(/"/g, '\\"')}"]\`.`
          })
        }
      }

      NAVIGATE_RE.lastIndex = 0
      let nm: RegExpExecArray | null
      while ((nm = NAVIGATE_RE.exec(line)) !== null) {
        const problem = checkLineRef(nm[1])
        if (problem) {
          issues.push({
            sourceFile: file.path,
            line: block.startLine + i,
            message: problem
          })
        }
      }
    }

    const nodes = extractFlowchartNodes(block.source)
    const clicks = extractClickedNodes(block.source)
    for (const [id, lineIdx] of nodes) {
      if (clicks.has(id)) continue
      issues.push({
        sourceFile: file.path,
        line: block.startLine + lineIdx,
        message:
          `flowchart node \`${id}\` has no \`click ${id} call navigate(...)\` handler. ` +
          `Every flowchart node should be navigable — point it at a source file, ` +
          `the parent architecture diagram, or \`overview.md\` if there's no better target.`
      })
    }
  }

  return issues
}

export function lintMermaid(files: FileInfo[]): MermaidIssue[] {
  const all: MermaidIssue[] = []
  for (const file of files) {
    if (!/\.(md|markdown)$/i.test(file.path)) continue
    for (const block of extractMermaidBlocks(file)) {
      all.push(...lintBlock(file, block))
    }
  }
  return all
}
