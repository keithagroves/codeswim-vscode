import { describe, it, expect } from 'vitest'
import { parseIgnore, compileIgnore } from '../src/codeswim-ignore'

function predicate(text: string): (p: string) => boolean {
  return compileIgnore(parseIgnore(text))
}

describe('parseIgnore', () => {
  it('skips blank lines and comment lines', () => {
    const patterns = parseIgnore(['# top comment', '', '   ', 'foo', '# trailing'].join('\n'))
    expect(patterns).toHaveLength(1)
    expect(patterns[0].raw).toBe('foo')
  })

  it('trims trailing whitespace', () => {
    const patterns = parseIgnore('foo   ')
    expect(patterns[0].raw).toBe('foo')
  })

  it('captures negation and dir-only flags', () => {
    const patterns = parseIgnore(['fixtures/', '!fixtures/keep/'].join('\n'))
    expect(patterns[0].dirOnly).toBe(true)
    expect(patterns[0].negated).toBe(false)
    expect(patterns[1].dirOnly).toBe(true)
    expect(patterns[1].negated).toBe(true)
  })
})

describe('compileIgnore — basename patterns', () => {
  it('matches a bare name at any depth', () => {
    const ignored = predicate('build')
    expect(ignored('build')).toBe(true)
    expect(ignored('a/build')).toBe(true)
    expect(ignored('a/build/x.txt')).toBe(true)
  })

  it('does not match a name that is only a prefix', () => {
    const ignored = predicate('build')
    expect(ignored('builder')).toBe(false)
    expect(ignored('a/builder/x.txt')).toBe(false)
  })

  it('matches a glob extension at any depth', () => {
    const ignored = predicate('*.log')
    expect(ignored('error.log')).toBe(true)
    expect(ignored('a/error.log')).toBe(true)
    expect(ignored('a/b/error.log')).toBe(true)
    expect(ignored('error.txt')).toBe(false)
  })
})

describe('compileIgnore — directory-only patterns', () => {
  it('matches files inside a directory of that name', () => {
    const ignored = predicate('fixtures/')
    expect(ignored('test/fixtures/overview.md')).toBe(true)
    expect(ignored('fixtures/x.ts')).toBe(true)
  })

  it('does not match a file whose own name equals the pattern', () => {
    const ignored = predicate('fixtures/')
    // `fixtures` here is the filename, not an ancestor — should not ignore.
    expect(ignored('fixtures')).toBe(false)
  })
})

describe('compileIgnore — anchored patterns', () => {
  it('leading slash anchors to root', () => {
    const ignored = predicate('/build')
    expect(ignored('build')).toBe(true)
    expect(ignored('build/x.ts')).toBe(true)
    expect(ignored('a/build')).toBe(false)
    expect(ignored('a/build/x.ts')).toBe(false)
  })

  it('embedded slash anchors to root', () => {
    const ignored = predicate('foo/bar')
    expect(ignored('foo/bar')).toBe(true)
    expect(ignored('foo/bar/baz.ts')).toBe(true)
    expect(ignored('x/foo/bar')).toBe(false)
  })
})

describe('compileIgnore — ** semantics', () => {
  it('foo/** matches everything inside foo', () => {
    const ignored = predicate('foo/**')
    expect(ignored('foo/bar')).toBe(true)
    expect(ignored('foo/bar/baz.ts')).toBe(true)
    expect(ignored('foo')).toBe(false)
    expect(ignored('other/foo/bar')).toBe(false)
  })

  it('**/foo matches foo at any depth', () => {
    const ignored = predicate('**/foo')
    expect(ignored('foo')).toBe(true)
    expect(ignored('a/foo')).toBe(true)
    expect(ignored('a/b/foo')).toBe(true)
  })
})

describe('compileIgnore — negation', () => {
  it('un-ignores a previously matched path', () => {
    const ignored = predicate(['fixtures/', '!fixtures/real/'].join('\n'))
    expect(ignored('fixtures/test.ts')).toBe(true)
    expect(ignored('fixtures/real/keeper.ts')).toBe(false)
  })

  it('last matching pattern wins', () => {
    const ignored = predicate(['*.ts', '!important.ts', 'important.ts'].join('\n'))
    expect(ignored('important.ts')).toBe(true)
    expect(ignored('a/important.ts')).toBe(true)
  })

  it('negation with no prior match is a no-op', () => {
    const ignored = predicate('!whatever')
    expect(ignored('whatever')).toBe(false)
  })
})

describe('compileIgnore — empty input', () => {
  it('returns a predicate that never ignores anything', () => {
    const ignored = predicate('')
    expect(ignored('foo')).toBe(false)
    expect(ignored('a/b/c')).toBe(false)
  })
})
