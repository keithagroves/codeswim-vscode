// Parsing helpers shared between the webview script and the test suite.
// Kept dependency-free so they can run in both Node and a browser webview.

export interface Frontmatter {
  name?: string
  description?: string
  tags?: string[]
}

export interface ParsedDoc {
  frontmatter: Frontmatter
  prose: string
  mermaidBlocks: string[]
  sections: ParsedSection[]
}

export type ParsedSection =
  | { type: 'markdown'; content: string }
  | { type: 'mermaid'; content: string }

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)/

// Tiny YAML-ish frontmatter parser: handles `key: value` and `key: [a, b, c]`.
// Sufficient for our convention; richer YAML stays out of the bundle.
export function parseFrontmatter(raw: string): Frontmatter {
  const out: Frontmatter = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const value = m[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      const list = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter((s) => s.length > 0)
      if (key === 'tags') out.tags = list
    } else {
      const cleaned = value.replace(/^["']|["']$/g, '')
      if (key === 'name') out.name = cleaned
      else if (key === 'description') out.description = cleaned
    }
  }
  return out
}

export function parseMarkdown(raw: string): ParsedDoc {
  // Strip a UTF-8 BOM if present — it's invisible in editors but breaks ^---.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  let body = raw
  let frontmatter: Frontmatter = {}
  const fmMatch = raw.match(FRONTMATTER_RE)
  if (fmMatch) {
    frontmatter = parseFrontmatter(fmMatch[1])
    body = raw.slice(fmMatch[0].length)
  }

  const mermaidBlocks: string[] = []
  const sections: ParsedSection[] = []
  let prose = ''
  let lastIndex = 0

  let offset = 0
  const lines = body.match(/[^\r\n]*(?:\r?\n|$)/g) ?? []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0) break

    const withoutNewline = line.replace(/\r?\n$/, '')
    const open = withoutNewline.match(FENCE_OPEN_RE)
    if (!open || !isMermaidInfo(open[3])) {
      offset += line.length
      continue
    }

    const fence = open[2]
    const fenceChar = fence[0]
    const minFenceLength = fence.length
    const contentStart = offset + line.length
    let scanOffset = contentStart
    let foundClose = false

    for (let j = i + 1; j < lines.length; j++) {
      const candidateLine = lines[j]
      const candidate = candidateLine.replace(/\r?\n$/, '')
      if (isClosingFence(candidate, fenceChar, minFenceLength)) {
        const markdown = body.slice(lastIndex, offset)
        const mermaid = body.slice(contentStart, scanOffset).replace(/\r?\n$/, '')
        prose += markdown
        addMarkdownSection(sections, markdown)
        sections.push({ type: 'mermaid', content: mermaid })
        mermaidBlocks.push(mermaid)
        lastIndex = scanOffset + candidateLine.length
        i = j
        offset = lastIndex
        foundClose = true
        break
      }
      scanOffset += candidateLine.length
    }

    if (!foundClose) {
      offset += line.length
    }
  }
  const tail = body.slice(lastIndex)
  prose += tail
  addMarkdownSection(sections, tail)

  return { frontmatter, prose: prose.trim(), mermaidBlocks, sections }
}

function addMarkdownSection(sections: ParsedSection[], content: string): void {
  const trimmed = content.trim()
  if (trimmed) sections.push({ type: 'markdown', content: trimmed })
}

function isMermaidInfo(info: string): boolean {
  const normalized = info.trim().toLowerCase()
  if (!normalized) return false
  const first = normalized.split(/\s+/)[0]
  return first === 'mermaid' || first === '{mermaid}' || first.startsWith('{mermaid,')
}

function isClosingFence(line: string, fenceChar: string, minFenceLength: number): boolean {
  const trimmedStart = line.replace(/^ {0,3}/, '')
  const match = trimmedStart.match(fenceChar === '`' ? /^(`+)[ \t]*$/ : /^(~+)[ \t]*$/)
  return !!match && match[1].length >= minFenceLength
}
