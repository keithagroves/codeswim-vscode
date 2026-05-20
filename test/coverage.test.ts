import { describe, it, expect } from 'vitest'
import { analyzeCoverage, extractLinks } from '../src/coverage'

const file = (path: string, content: string) => ({ path, content })

describe('extractLinks', () => {
  it('finds a navigate() call inside a mermaid fence', () => {
    const links = extractLinks(
      file(
        'overview.md',
        '```mermaid\nflowchart TD\nclick X call navigate("./a.md")\n```'
      )
    )
    const nav = links.filter((l) => l.kind === 'navigate')
    expect(nav).toHaveLength(1)
    expect(nav[0].target).toBe('./a.md')
    expect(nav[0].resolvedPath).toBe('a.md')
    expect(nav[0].line).toBe(3)
  })

  it('finds a markdown link', () => {
    const links = extractLinks(file('docs/x.md', 'see [the file](./y.md)'))
    expect(links).toHaveLength(1)
    expect(links[0].kind).toBe('markdown')
    expect(links[0].resolvedPath).toBe('docs/y.md')
  })

  it('resolves ../ in markdown links', () => {
    const links = extractLinks(file('docs/sub/x.md', 'go [up two](../../top.md)'))
    expect(links[0].resolvedPath).toBe('top.md')
  })

  it('returns null resolved path for paths that escape the root', () => {
    const links = extractLinks(file('a.md', '[oops](../../../../etc/passwd)'))
    expect(links[0]).toBeUndefined() // skipped because resolved is null and not external
  })

  it('skips external links and anchors', () => {
    const links = extractLinks(
      file('a.md', '[home](https://example.com) [section](#foo) [mail](mailto:x@y)')
    )
    expect(links).toHaveLength(0)
  })

  it('strips fragment and query when resolving', () => {
    const links = extractLinks(file('a.md', '[link](./b.md#section?x=1)'))
    expect(links[0].resolvedPath).toBe('b.md')
  })

  it('finds multiple links on a single line', () => {
    const links = extractLinks(file('a.md', '[one](./b.md) and [two](./c.md)'))
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.resolvedPath)).toEqual(['b.md', 'c.md'])
  })

  it('reports correct line numbers across CRLF', () => {
    const links = extractLinks(file('a.md', 'first\r\n[x](./b.md)\r\nthird'))
    expect(links[0].line).toBe(2)
  })

  it('only counts navigate() calls inside ```mermaid fences', () => {
    // navigate() in a non-mermaid fenced block (e.g. ```markdown showing the
    // syntax in docs) is illustrative, not a real link.
    const input = [
      'Use `navigate("./foo.md")` like this:',
      '',
      '```markdown',
      'click X call navigate("./illustrative.md")',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[A]',
      '  click A call navigate("./real.md")',
      '```'
    ].join('\n')
    const links = extractLinks(file('a.md', input))
    const nav = links.filter((l) => l.kind === 'navigate')
    expect(nav).toHaveLength(1)
    expect(nav[0].target).toBe('./real.md')
  })

  it('still extracts markdown links from prose, regardless of fences', () => {
    const input = [
      '[a](./a.md)',
      '',
      '```text',
      '[b](./b.md)',
      '```'
    ].join('\n')
    const links = extractLinks(file('top.md', input))
    // Markdown link extraction is global — code-block content is also
    // checked since the link target syntax is identical.
    const mdLinks = links.filter((l) => l.kind === 'markdown')
    expect(mdLinks.map((l) => l.target).sort()).toEqual(['./a.md', './b.md'])
  })
})

describe('analyzeCoverage — broken links', () => {
  it('flags links to files that do not exist', () => {
    const report = analyzeCoverage([
      file('overview.md', '[gone](./missing.md)\n[ok](./real.md)'),
      file('real.md', 'content')
    ])
    expect(report.brokenLinks).toHaveLength(1)
    expect(report.brokenLinks[0].target).toBe('./missing.md')
    expect(report.brokenLinks[0].sourceFile).toBe('overview.md')
  })

  it('flags broken navigate() targets', () => {
    const report = analyzeCoverage([
      file(
        'overview.md',
        '```mermaid\nflowchart TD\nclick X call navigate("./gone/foo.ts")\n```'
      )
    ])
    expect(report.brokenLinks).toHaveLength(1)
    expect(report.brokenLinks[0].kind).toBe('navigate')
    expect(report.brokenLinks[0].resolvedPath).toBe('gone/foo.ts')
  })

  it('reports zero broken when everything resolves', () => {
    const report = analyzeCoverage([
      file('overview.md', '[a](./a.md) [b](./b.md)'),
      file('a.md', ''),
      file('b.md', '')
    ])
    expect(report.brokenLinks).toHaveLength(0)
    expect(report.totals.totalLinks).toBe(2)
  })
})

describe('analyzeCoverage — orphan diagrams', () => {
  it('marks diagrams unreachable from overview as orphans', () => {
    const report = analyzeCoverage([
      file('overview.md', '[a](./a.md)'),
      file('a.md', 'content'),
      file('orphan.md', 'lonely diagram')
    ])
    expect(report.orphanDiagrams).toEqual(['orphan.md'])
  })

  it('walks transitive .md links from the entry', () => {
    const report = analyzeCoverage([
      file('overview.md', '[a](./a.md)'),
      file('a.md', '[b](./b.md)'),
      file('b.md', '')
    ])
    expect(report.orphanDiagrams).toEqual([])
  })

  it('considers overview.md the default entry', () => {
    const report = analyzeCoverage([
      file('overview.md', ''),
      file('zoo.md', '[overview](./overview.md)')
    ])
    // zoo.md is not reachable from overview.md; it is orphan.
    expect(report.entry).toBe('overview.md')
    expect(report.orphanDiagrams).toEqual(['zoo.md'])
  })

  it('returns null entry when no root-level overview.md exists', () => {
    const report = analyzeCoverage([file('docs/a.md', ''), file('docs/sub/b.md', '')])
    expect(report.entry).toBe(null)
    // With no entry, every diagram is orphan.
    expect(report.orphanDiagrams).toEqual(['docs/a.md', 'docs/sub/b.md'])
  })

  it('does not pick a nested overview.md as the project entry', () => {
    // Common case: a `examples/sample-architecture/` folder has its own
    // overview.md but it documents a fixture, not this project.
    const report = analyzeCoverage([
      file('plan.md', ''),
      file('examples/fixture/overview.md', '[a](./a.md)'),
      file('examples/fixture/a.md', '')
    ])
    expect(report.entry).toBe(null)
  })

  it('does not follow links to non-md targets when computing reachability', () => {
    const report = analyzeCoverage([
      file('overview.md', '[code](./src/foo.ts) [diag](./other.md)'),
      file('src/foo.ts', ''),
      file('other.md', '[unreachable](./island.md)'),
      file('island.md', '')
    ])
    // island.md IS reachable: overview -> other -> island.
    expect(report.orphanDiagrams).toEqual([])
  })
})

describe('analyzeCoverage — uncovered sources', () => {
  it('reports source files no diagram references', () => {
    const report = analyzeCoverage([
      file('overview.md', '[a](./src/a.ts)'),
      file('src/a.ts', ''),
      file('src/b.ts', '')
    ])
    expect(report.uncoveredSources).toEqual(['src/b.ts'])
    expect(report.totals.coveredSources).toBe(1)
    expect(report.totals.sources).toBe(2)
  })

  it('only counts files matching the source predicate', () => {
    const report = analyzeCoverage(
      [
        file('overview.md', '[js](./src/a.js)'),
        file('src/a.js', ''),
        file('src/data.json', '{}')
      ],
      { isSourceFile: (p) => p.endsWith('.js') }
    )
    expect(report.totals.sources).toBe(1)
    expect(report.uncoveredSources).toEqual([])
  })
})

describe('analyzeCoverage — totals and edge cases', () => {
  it('returns sane totals for an empty workspace', () => {
    const report = analyzeCoverage([])
    expect(report.totals).toEqual({
      diagrams: 0,
      sources: 0,
      coveredSources: 0,
      totalLinks: 0,
      brokenLinkCount: 0,
      mermaidIssueCount: 0
    })
    expect(report.entry).toBe(null)
  })

  it('does not count external URLs as links', () => {
    const report = analyzeCoverage([
      file('overview.md', '[ext](https://x.com) [int](./a.md)'),
      file('a.md', '')
    ])
    expect(report.totals.totalLinks).toBe(1)
  })

  it('respects a custom ignore predicate (no false-positive uncovered)', () => {
    const report = analyzeCoverage(
      [
        file('overview.md', ''),
        file('src/legacy.ts', ''),
        file('src/current.ts', '')
      ],
      { ignore: (p) => p.includes('legacy') }
    )
    expect(report.uncoveredSources).toEqual(['src/current.ts'])
  })
})
