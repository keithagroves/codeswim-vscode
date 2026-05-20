import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')

// In `--watch` mode keep things unminified for readable stack traces; the
// production build (and `npm run package`) minifies the webview bundle so
// mermaid doesn't ship as a 6 MB file.
const minify = !watch

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  minify
}

// Standalone CLI for `codeswim-coverage`. Same coverage logic as the
// extension's button, runnable from a shell or CI.
const cliConfig = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'out/cli.js',
  sourcemap: true,
  logLevel: 'info',
  minify,
  banner: { js: '#!/usr/bin/env node' }
}

const webviewConfig = {
  entryPoints: ['src/webview.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'media/webview.js',
  sourcemap: true,
  logLevel: 'info',
  minify
}

if (watch) {
  const extCtx = await context(extensionConfig)
  const webCtx = await context(webviewConfig)
  const cliCtx = await context(cliConfig)
  await Promise.all([extCtx.watch(), webCtx.watch(), cliCtx.watch()])
  console.log('watching…')
} else {
  await Promise.all([build(extensionConfig), build(webviewConfig), build(cliConfig)])
}
