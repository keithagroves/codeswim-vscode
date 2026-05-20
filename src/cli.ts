// codeswim-coverage CLI: runs the same analysis the VS Code extension's
// "Check coverage" button runs, but for agents and CI.
//
// Usage:
//   codeswim-coverage [path]               human-readable report
//   codeswim-coverage [path] --json        machine-readable report
//   codeswim-coverage [path] --strict      exit 1 if any drift detected
//
// `path` defaults to the current working directory.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import { analyzeCoverage, defaultIgnore, type FileInfo } from './coverage'
import { compileIgnore, parseIgnore } from './codeswim-ignore'

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '.vscode',
  '.idea',
  '.DS_Store'
])

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (entry.isFile()) files.push(full)
  }
}

function readFiles(root: string): FileInfo[] {
  const all: string[] = []
  walk(root, all)
  const out: FileInfo[] = []
  for (const f of all) {
    try {
      const stat = statSync(f)
      if (stat.size > 1_000_000) continue // skip > 1 MB, likely not source
      out.push({ path: relative(root, f).replace(/\\/g, '/'), content: readFileSync(f, 'utf-8') })
    } catch {
      // unreadable / binary — skip
    }
  }
  return out
}

interface Args {
  root: string
  json: boolean
  strict: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { root: process.cwd(), json: false, strict: false, help: false }
  const positional: string[] = []
  for (const a of argv) {
    if (a === '--json') out.json = true
    else if (a === '--strict') out.strict = true
    else if (a === '-h' || a === '--help') out.help = true
    else positional.push(a)
  }
  if (positional.length > 0) out.root = resolve(positional[0])
  return out
}

function printHumanReport(root: string, report: ReturnType<typeof analyzeCoverage>): void {
  console.log(`Diagram coverage for ${root}`)
  console.log(`  Entry: ${report.entry ?? '(none — no markdown found)'}`)
  console.log('')
  console.log(
    `Diagrams:           ${report.totals.diagrams}` +
      `   (orphan: ${report.orphanDiagrams.length})`
  )
  console.log(
    `Source files:       ${report.totals.sources}` +
      `   (covered: ${report.totals.coveredSources}, uncovered: ${report.uncoveredSources.length})`
  )
  console.log(
    `Links checked:      ${report.totals.totalLinks}` +
      `   (broken: ${report.totals.brokenLinkCount})`
  )
  console.log(`Mermaid issues:     ${report.totals.mermaidIssueCount}`)
  console.log('')

  if (report.brokenLinks.length > 0) {
    console.log('Broken links:')
    for (const b of report.brokenLinks) {
      console.log(`  ${b.sourceFile}:${b.line}:${b.column}  ${b.kind}("${b.target}")`)
    }
    console.log('')
  }
  if (report.orphanDiagrams.length > 0) {
    console.log('Orphan diagrams (not reachable from entry):')
    for (const o of report.orphanDiagrams) console.log(`  ${o}`)
    console.log('')
  }
  if (report.uncoveredSources.length > 0) {
    console.log('Source files referenced by no diagram:')
    for (const s of report.uncoveredSources) console.log(`  ${s}`)
    console.log('')
  }
  if (report.mermaidIssues.length > 0) {
    console.log('Mermaid issues (will not render):')
    for (const m of report.mermaidIssues) {
      console.log(`  ${m.sourceFile}:${m.line}  ${m.message}`)
    }
    console.log('')
  }
  if (
    report.brokenLinks.length === 0 &&
    report.orphanDiagrams.length === 0 &&
    report.uncoveredSources.length === 0 &&
    report.mermaidIssues.length === 0
  ) {
    console.log('All checks passed — diagrams are aligned with the codebase.')
  }
}

function printHelp(): void {
  console.log(`codeswim-coverage — check that diagrams stay aligned with the codebase

Usage:
  codeswim-coverage [path]            human-readable report (default: cwd)
  codeswim-coverage [path] --json     emit JSON
  codeswim-coverage [path] --strict   exit 1 if any drift is detected
  codeswim-coverage --help

Checks:
  - Broken links: any navigate("...") or markdown []() that doesn't resolve
  - Orphan diagrams: .md files unreachable from the entry (overview.md)
  - Uncovered sources: source files no diagram references
  - Mermaid issues: blocks that won't render (e.g. click in sequenceDiagram)
`)
}

function loadProjectIgnore(root: string): (path: string) => boolean {
  const ignoreFile = join(root, '.codeswimignore')
  if (!existsSync(ignoreFile)) return () => false
  try {
    const text = readFileSync(ignoreFile, 'utf-8')
    return compileIgnore(parseIgnore(text))
  } catch {
    return () => false
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const userIgnore = loadProjectIgnore(args.root)
  const ignore = (p: string): boolean => defaultIgnore(p) || userIgnore(p)
  const files = readFiles(args.root)
  const report = analyzeCoverage(files, { ignore })

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printHumanReport(args.root, report)
  }

  const drift =
    report.totals.brokenLinkCount > 0 ||
    report.orphanDiagrams.length > 0 ||
    report.uncoveredSources.length > 0 ||
    report.totals.mermaidIssueCount > 0
  if (args.strict && drift) {
    process.exit(1)
  }
}

main()
