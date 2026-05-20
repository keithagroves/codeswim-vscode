# Marketplace publish checklist

A working playbook for shipping codeswim to the VS Code Marketplace.
Walk top-to-bottom the first time; later releases can skip the
one-time setup section.

## 1. One-time setup

- [x] **Create an Azure DevOps organization.**
- [x] **Create a Personal Access Token (PAT).** Scopes: Marketplace →
      Manage; All accessible organizations.
- [x] **Create the Marketplace publisher** (`codeswim`).
- [x] **Log vsce in** — `npx vsce login codeswim` (PAT verified
      2026-05-20).

## 2. package.json pre-flight

- [x] `name`, `displayName`, `description` make sense on the listing
- [x] `version` bumped to `0.1.15` (was `0.1.14`)
- [x] `publisher` matches the Marketplace publisher ID
- [x] `repository` URL set
- [x] `icon` path resolves (`media/icon.png`)
- [x] `engines.vscode` matches the lowest VS Code the build targets
- [x] `categories` set to `["Visualization"]`
- [x] `keywords`: `mermaid`, `diagram`, `markdown`, `navigation`,
      `architecture`
- [x] `license: "MIT"`

## 3. Repo housekeeping

- [x] **`LICENSE`** (MIT) at the repo root
- [x] **`CHANGELOG.md`** at the repo root with the 0.1.15 entry
- [x] **`README.md`** renders correctly — the Marketplace runs its
      own markdown pipeline, so check for:
      - relative image URLs that don't resolve (today we rely on the
        `repository` field)
      - HTML that gets stripped (most inline HTML is fine; raw
        `<script>` is not)
      - broken anchor links between headings
- [x] **`.vscodeignore`** excludes everything that should not ship:
      currently strips `src/**`, `test/**`, sourcemaps, configs, and
      the `.svg` icon. Re-check after adding files.

## 4. Pre-publish verification

- [ ] `npm run typecheck` — clean
- [ ] `npm test` — green
- [ ] `npm run build` — produces `out/extension.js`,
      `media/webview.js`, `out/cli.js`
- [ ] `npm run coverage .` — coverage CLI reports no drift on its own
      repo (dogfood)
- [ ] **Manual smoke test in an Extension Development Host** (F5):
  - [ ] `Cmd+K V` on a markdown file with a mermaid block renders the
        diagram
  - [ ] Clicking a `.md` node pushes a breadcrumb; clicking back
        returns
  - [ ] Clicking a non-`.md` node opens it in the editor area
  - [ ] Editing the source file live-updates the preview
  - [ ] Activity-bar **Diagrams** view shows the workspace's
        `overview.md` tree
  - [ ] **Check Coverage** runs and reports
  - [ ] CSP warnings absent from the webview devtools console
- [ ] **Package locally and side-load** to catch packaging-only bugs:
      ```bash
      npm run package
      code --install-extension codeswim-<version>.vsix --force
      ```
      Reload window, run the same smoke test against the installed
      build (not the dev host).

## 5. Publish

- [ ] Tag the release: `git tag v<version> && git push --tags`
- [ ] Publish:
      ```bash
      npx vsce publish
      # or, to upload the .vsix you already built:
      npx vsce publish --packagePath codeswim-<version>.vsix
      ```
- [ ] Confirm the listing at
      <https://marketplace.visualstudio.com/items?itemName=codeswim.codeswim>
      (it can take a couple of minutes to appear). Check that the
      icon, screenshots, README, and changelog all rendered.
- [ ] Install from the Marketplace into a clean VS Code profile and
      re-run the smoke test — catches "works locally, broken on
      Marketplace" regressions (usually `.vscodeignore` mistakes).

## 6. After publish

- [ ] Bump `package.json` to the next `-dev` or open-development
      version so the next `vsce publish` doesn't accidentally
      republish the released one
- [ ] Add a row to `CHANGELOG.md` under "Unreleased"
- [ ] Announce / link the Marketplace page from
      [codeswim](https://github.com/keithagroves/codeswim) and
      [codeswim-example](https://github.com/keithagroves/codeswim-example)
      READMEs if not already linked
