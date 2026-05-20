import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parseMarkdown, parseFrontmatter } from '../src/parse'

describe('parseFrontmatter', () => {
  it('extracts simple key/value pairs', () => {
    const fm = parseFrontmatter('name: Triage\ndescription: A small backend')
    expect(fm.name).toBe('Triage')
    expect(fm.description).toBe('A small backend')
  })

  it('parses tags as a list', () => {
    const fm = parseFrontmatter('tags: [overview, architecture]')
    expect(fm.tags).toEqual(['overview', 'architecture'])
  })

  it('strips quotes from values', () => {
    const fm = parseFrontmatter('name: "Quoted Name"\ndescription: \'single-quoted\'')
    expect(fm.name).toBe('Quoted Name')
    expect(fm.description).toBe('single-quoted')
  })

  it('preserves colons inside values', () => {
    const fm = parseFrontmatter('description: A: B: C')
    expect(fm.description).toBe('A: B: C')
  })

  it('ignores unknown keys', () => {
    const fm = parseFrontmatter('foo: bar\nname: Real')
    expect(fm.name).toBe('Real')
    expect((fm as Record<string, unknown>).foo).toBeUndefined()
  })
})

describe('parseMarkdown — frontmatter handling', () => {
  it('extracts frontmatter and strips it from the body', () => {
    const input = '---\nname: X\ndescription: Y\n---\n\nBody text here.'
    const result = parseMarkdown(input)
    expect(result.frontmatter.name).toBe('X')
    expect(result.frontmatter.description).toBe('Y')
    expect(result.prose).toBe('Body text here.')
  })

  it('returns no frontmatter when the file has none', () => {
    const result = parseMarkdown('Just plain text.')
    expect(result.frontmatter).toEqual({})
    expect(result.prose).toBe('Just plain text.')
  })

  it('handles CRLF-encoded frontmatter', () => {
    const input = '---\r\nname: X\r\n---\r\n\r\nBody.'
    const result = parseMarkdown(input)
    expect(result.frontmatter.name).toBe('X')
    expect(result.prose).toBe('Body.')
  })

  it('strips a leading UTF-8 BOM', () => {
    const input = '﻿---\nname: X\n---\n\nBody.'
    const result = parseMarkdown(input)
    expect(result.frontmatter.name).toBe('X')
    expect(result.prose).toBe('Body.')
  })
})

describe('parseMarkdown — mermaid blocks', () => {
  it('finds a single mermaid block', () => {
    const input = ['Some prose.', '', '```mermaid', 'flowchart TD', '  A --> B', '```', ''].join(
      '\n'
    )
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(1)
    expect(result.mermaidBlocks[0]).toBe('flowchart TD\n  A --> B')
  })

  it('finds multiple mermaid blocks', () => {
    const input = [
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      'Some prose.',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```'
    ].join('\n')
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(2)
    expect(result.mermaidBlocks[0]).toBe('flowchart TD\n  A --> B')
    expect(result.mermaidBlocks[1]).toBe('sequenceDiagram\n  A->>B: hi')
  })

  it('returns no blocks for files with only prose', () => {
    const input = '# Title\n\nThis file has no diagrams.'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(0)
    expect(result.prose).toContain('This file has no diagrams.')
  })

  it('finds a block immediately after frontmatter (no blank line)', () => {
    const input = '---\nname: X\n---\n```mermaid\nflowchart TD\n  A --> B\n```'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(1)
  })

  it('finds a block at end-of-file with no trailing newline', () => {
    const input = 'Prose.\n\n```mermaid\nflowchart TD\n  A --> B\n```'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(1)
  })

  it('handles CRLF line endings inside the fence', () => {
    const input = '```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(1)
    // The captured body should contain the diagram text; CRs are preserved
    // but mermaid handles them fine.
    expect(result.mermaidBlocks[0]).toContain('flowchart TD')
    expect(result.mermaidBlocks[0]).toContain('A --> B')
  })

  it('matches fences with 4 backticks (CommonMark allows ≥3)', () => {
    const input = '````mermaid\nflowchart TD\n  A --> B\n````'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(1)
  })

  it('matches capitalized mermaid info strings with attributes', () => {
    const input = '```Mermaid title="Checkout"\nflowchart LR\n  A --> B\n```'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toEqual(['flowchart LR\n  A --> B'])
  })

  it('matches lightly indented and braced mermaid fences', () => {
    const input = '   ```{mermaid}\nflowchart TD\n  A --> B\n   ```'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toEqual(['flowchart TD\n  A --> B'])
  })

  it('matches tilde mermaid fences', () => {
    const input = '~~~mermaid\nsequenceDiagram\n  A->>B: hi\n~~~'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toEqual(['sequenceDiagram\n  A->>B: hi'])
  })

  it('does not match a fence inside indented prose (must be line start)', () => {
    const input = 'Some prose with `inline code` and:\n\n    ```mermaid\n    code\n    ```'
    const result = parseMarkdown(input)
    // Indented fence isn't a real fence; we should find none.
    expect(result.mermaidBlocks).toHaveLength(0)
  })

  it('does not close on the wrong fence character', () => {
    const input = '```mermaid\nflowchart TD\n~~~\ntext after'
    const result = parseMarkdown(input)
    expect(result.mermaidBlocks).toHaveLength(0)
    expect(result.prose).toContain('flowchart TD')
  })

  it('keeps prose outside of mermaid blocks', () => {
    const input =
      'Before block.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nAfter block.'
    const result = parseMarkdown(input)
    expect(result.prose).toContain('Before block.')
    expect(result.prose).toContain('After block.')
    expect(result.prose).not.toContain('flowchart TD')
  })

  it('preserves markdown and mermaid sections in document order', () => {
    const input =
      'Before block.\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n## After block'
    const result = parseMarkdown(input)
    expect(result.sections).toEqual([
      { type: 'markdown', content: 'Before block.' },
      { type: 'mermaid', content: 'flowchart TD\n  A --> B' },
      { type: 'markdown', content: '## After block' }
    ])
  })

  it('is idempotent across calls (regex /g lastIndex is reset)', () => {
    const input = '```mermaid\nflowchart TD\n  A --> B\n```'
    const a = parseMarkdown(input)
    const b = parseMarkdown(input)
    expect(a.mermaidBlocks).toEqual(b.mermaidBlocks)
    expect(a.mermaidBlocks).toHaveLength(1)
  })
})

describe('parseMarkdown — example fixture', () => {
  // Exact copy of the project's overview.md. Regression test for a bug where
  // this file was reportedly being treated as having no mermaid block.
  const fixture = readFileSync(resolve(__dirname, 'fixtures/overview.md'), 'utf-8')

  it('extracts frontmatter from overview.md', () => {
    const result = parseMarkdown(fixture)
    expect(result.frontmatter.name).toBe('Triage')
    expect(result.frontmatter.description).toContain('feedback-collection backend')
    expect(result.frontmatter.tags).toEqual(['overview', 'architecture'])
  })

  it('finds exactly one mermaid block in overview.md', () => {
    const result = parseMarkdown(fixture)
    expect(result.mermaidBlocks).toHaveLength(1)
    expect(result.mermaidBlocks[0]).toContain('flowchart TD')
    expect(result.mermaidBlocks[0]).toContain(
      'click API call navigate("./architecture/api.md")'
    )
  })

  it('keeps the prose and section headings', () => {
    const result = parseMarkdown(fixture)
    expect(result.prose).toContain('Where to look first')
    expect(result.prose).toContain('Project conventions')
    expect(result.prose).not.toContain('flowchart TD')
  })
})
