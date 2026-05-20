// Project-level ignore patterns loaded from `.codeswimignore` at the
// workspace root. Supports a deliberate subset of gitignore semantics:
//
//   - blank lines + `#` comments are skipped
//   - `pattern`       matches any file or dir named `pattern` at any depth
//   - `pattern/`      directory-only: matches only when `pattern` appears as
//                     an ancestor directory of the path
//   - `/pattern`      anchored: matches only at the workspace root
//   - `foo/bar`       embedded slash → anchored to root
//   - `*`             matches any single path segment (no `/`)
//   - `?`             matches a single character within a segment
//   - `**`            matches across path separators (zero or more dirs when
//                     followed by `/`)
//   - `!pattern`      negation: un-ignore something a previous pattern matched
//
// Patterns are evaluated in order; the last matching pattern wins. The
// compiled predicate returns true iff the path should be ignored.

export interface IgnorePattern {
  raw: string
  negated: boolean
  regex: RegExp
  dirOnly: boolean
}

export function parseIgnore(text: string): IgnorePattern[] {
  const out: IgnorePattern[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line || line.startsWith('#')) continue
    out.push(compile(line))
  }
  return out
}

export function compileIgnore(patterns: IgnorePattern[]): (path: string) => boolean {
  if (patterns.length === 0) return () => false
  return (path: string) => {
    const parts = path.split('/').filter((p) => p.length > 0)
    if (parts.length === 0) return false
    let ignored = false
    for (const pattern of patterns) {
      const limit = pattern.dirOnly ? parts.length - 1 : parts.length
      let hit = false
      for (let i = 1; i <= limit; i++) {
        const candidate = parts.slice(0, i).join('/')
        if (pattern.regex.test(candidate)) {
          hit = true
          break
        }
      }
      if (hit) ignored = !pattern.negated
    }
    return ignored
  }
}

const REGEX_SPECIAL = '.+^$()|{}[]\\'

function compile(raw: string): IgnorePattern {
  let pattern = raw
  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  let dirOnly = false
  if (pattern.endsWith('/')) {
    dirOnly = true
    pattern = pattern.slice(0, -1)
  }
  let anchored = false
  if (pattern.startsWith('/')) {
    anchored = true
    pattern = pattern.slice(1)
  } else if (pattern.includes('/')) {
    // An embedded slash (after we already stripped any trailing one) anchors
    // the pattern, per gitignore.
    anchored = true
  }

  let body = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      i += 2
      if (pattern[i] === '/') {
        body += '(?:.*/)?'
        i++
      } else {
        body += '.*'
      }
    } else if (ch === '*') {
      body += '[^/]*'
      i++
    } else if (ch === '?') {
      body += '[^/]'
      i++
    } else if (REGEX_SPECIAL.includes(ch)) {
      body += '\\' + ch
      i++
    } else {
      body += ch
      i++
    }
  }

  const regexStr = anchored ? `^${body}$` : `^(?:.*/)?${body}$`
  return { raw, negated, regex: new RegExp(regexStr), dirOnly }
}
