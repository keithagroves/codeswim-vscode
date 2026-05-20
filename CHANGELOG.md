# Changelog

All notable changes to the codeswim VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.16] - 2026-05-20

### Fixed
- README hero now references the hi-res `media/icon.png` so the logo
  renders with the white background on the Marketplace listing.

## [0.1.15] - 2026-05-20

First public Marketplace release.

### Added
- Side-panel preview for markdown files containing a mermaid block,
  triggered from the editor title bar or `Cmd+K V` / `Ctrl+K V`.
- Click-to-navigate on flowchart nodes via
  `click NodeId call navigate("…")`. `.md` targets push a breadcrumb;
  other targets open in the editor area. `#L10-L22` line refs jump to
  and highlight a range.
- Breadcrumb history with click-to-jump-back.
- Live reload on unsaved edits and external file changes.
- Activity-bar **Diagrams** view rooted at the workspace's
  `overview.md`, with a welcome action that scaffolds one if missing.
- **Check Coverage** command that verifies every source file is
  reachable from a diagram and every diagram is reachable from
  `overview.md`.
- `codeswim-coverage` CLI exposing the same coverage analysis for
  agents and CI, with `--json` and `--strict` modes.
- `.codeswimignore` support (gitignore-subset syntax) to extend the
  built-in ignore list.
