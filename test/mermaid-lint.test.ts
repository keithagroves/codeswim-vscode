import { describe, it, expect } from 'vitest'
import { checkLineRef, lintMermaid } from '../src/mermaid-lint'

const file = (path: string, content: string) => ({ path, content })

const wrap = (mermaid: string): string => '```mermaid\n' + mermaid + '\n```\n'

describe('checkLineRef', () => {
  it('returns null when no fragment', () => {
    expect(checkLineRef('./src/foo.ts')).toBeNull()
  })

  it('accepts #L10', () => {
    expect(checkLineRef('./src/foo.ts#L10')).toBeNull()
  })

  it('accepts #L10-L22 and #L10-22', () => {
    expect(checkLineRef('./foo.ts#L10-L22')).toBeNull()
    expect(checkLineRef('./foo.ts#L10-22')).toBeNull()
  })

  it('flags #Lfoo as malformed', () => {
    const msg = checkLineRef('./foo.ts#Lfoo')
    expect(msg).not.toBeNull()
    expect(msg).toContain('#Lfoo')
  })

  it('flags #L0 as 1-indexed violation', () => {
    const msg = checkLineRef('./foo.ts#L0')
    expect(msg).not.toBeNull()
    expect(msg).toContain('1-indexed')
  })

  it('flags reversed ranges like #L20-L5', () => {
    const msg = checkLineRef('./foo.ts#L20-L5')
    expect(msg).not.toBeNull()
    expect(msg).toContain('reversed')
  })

  it('also flags non-line-ref anchors like #section', () => {
    // Navigate targets reserve anchors for line refs by convention, so a
    // section-style anchor is treated as a malformed line ref.
    const msg = checkLineRef('./foo.md#intro')
    expect(msg).not.toBeNull()
  })
})

describe('lintMermaid line-ref check', () => {
  it('reports malformed line ref inside a flowchart navigate call', () => {
    const issues = lintMermaid([
      file(
        'overview.md',
        wrap(['flowchart TD', 'A', 'click A call navigate("./src/foo.ts#Lfoo")'].join('\n'))
      )
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0].sourceFile).toBe('overview.md')
    expect(issues[0].message).toContain('#Lfoo')
  })

  it('reports a reversed range with the right line number', () => {
    const issues = lintMermaid([
      file(
        'docs/x.md',
        '\n\n' + wrap(['flowchart LR', 'A', 'click A call navigate("./foo.ts#L20-L5")'].join('\n'))
      )
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('reversed')
    // Two blank lines + opening fence on line 3, then flowchart=4, A=5, click=6
    expect(issues[0].line).toBe(6)
  })

  it('does not flag well-formed line refs', () => {
    const issues = lintMermaid([
      file(
        'overview.md',
        wrap(
          [
            'flowchart TD',
            'A',
            'click A call navigate("./foo.ts#L10-L22")',
            'B',
            'click B call navigate("./bar.ts")'
          ].join('\n')
        )
      )
    ])
    expect(issues).toHaveLength(0)
  })

  it('does not run the line-ref check inside non-flowchart diagrams', () => {
    // The non-flowchart-click check already flags this case with its own
    // (more useful) message; we shouldn't double-report.
    const issues = lintMermaid([
      file(
        'overview.md',
        wrap(
          ['sequenceDiagram', 'A->>B: hi', 'click A call navigate("./foo.ts#Lfoo")'].join('\n')
        )
      )
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('flowchart-only')
  })
})

describe('lintMermaid missing-click check', () => {
  const missingClickIssues = (issues: ReturnType<typeof lintMermaid>) =>
    issues.filter((i) => i.message.includes('has no `click'))

  it('reports a flowchart node without a click handler', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart TD',
              'Client[Web] --> API[API Gateway]',
              'click API call navigate("./api.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('`Client`')
  })

  it('does not flag nodes that have a click handler', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart TD',
              'A[a] --> B[b]',
              'click A call navigate("./a.md")',
              'click B call navigate("./b.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(0)
  })

  it('detects nodes that only appear as bare edge endpoints', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(['flowchart LR', 'A --> B', 'click A call navigate("./a.md")'].join('\n'))
        )
      ])
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('`B`')
  })

  it('handles cylinder shapes `[(...)]`', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file('overview.md', wrap(['flowchart TD', 'API --> DB[(SQLite)]'].join('\n')))
      ])
    )
    const all = issues.map((i) => i.message).join('\n')
    expect(all).toMatch(/`API`/)
    expect(all).toMatch(/`DB`/)
  })

  it('handles inline edge text `A -- text --> B`', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart LR',
              'A -- HTTP --> B',
              'click A call navigate("./a.md")',
              'click B call navigate("./b.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(0)
  })

  it('handles piped edge labels `-->|text|`', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart LR',
              'A -->|sometimes| B',
              'click A call navigate("./a.md")',
              'click B call navigate("./b.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(0)
  })

  it('handles chained edges `A --> B --> C`', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart LR',
              'A --> B --> C',
              'click A call navigate("./a.md")',
              'click C call navigate("./c.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('`B`')
  })

  it('ignores subgraph headers and the `direction` keyword', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart TD',
              'subgraph backend',
              '  direction LR',
              '  A[A] --> B[B]',
              'end',
              'click A call navigate("./a.md")',
              'click B call navigate("./b.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(0)
  })

  it('does not run inside non-flowchart diagrams', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file('overview.md', wrap(['sequenceDiagram', 'Alice->>Bob: hi'].join('\n')))
      ])
    )
    expect(issues).toHaveLength(0)
  })

  it('reports the line where the unclicked node first appears', () => {
    const issues = missingClickIssues(
      lintMermaid([
        file(
          'overview.md',
          wrap(
            [
              'flowchart TD',
              'A[a] --> B[b]',
              'B --> Lonely',
              'click A call navigate("./a.md")',
              'click B call navigate("./b.md")'
            ].join('\n')
          )
        )
      ])
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('`Lonely`')
    // Opening fence is file line 1; `flowchart TD` is line 2; `A[a]-->B[b]`
    // is line 3; `B --> Lonely` is line 4.
    expect(issues[0].line).toBe(4)
  })
})
