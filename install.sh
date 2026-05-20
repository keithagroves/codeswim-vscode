#!/usr/bin/env bash
# Build, package, and install the codeswim extension locally.
#
# Usage:
#   ./install.sh              # bump patch, build, package, install
#   ./install.sh --minor      # bump minor instead
#   ./install.sh --major      # bump major instead
#   ./install.sh --no-bump    # use current version as-is
#
# Why bump by default: VS Code caches by version, so re-installing the same
# version sometimes doesn't pick up changes cleanly.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v code >/dev/null 2>&1; then
  echo "error: 'code' CLI not found in PATH." >&2
  echo "In VS Code: Cmd+Shift+P -> 'Shell Command: Install code command in PATH'" >&2
  exit 1
fi

bump="patch"
case "${1:-}" in
  --no-bump) bump="" ;;
  --major|--minor|--patch) bump="${1#--}" ;;
  "") ;;
  -h|--help)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "error: unknown option '$1'" >&2
    echo "usage: $0 [--no-bump|--patch|--minor|--major]" >&2
    exit 1
    ;;
esac

if [[ -n "$bump" ]]; then
  npm version "$bump" --no-git-tag-version
fi

npm run build
npm run package

vsix=$(ls -t codeswim-*.vsix 2>/dev/null | head -n 1)
if [[ -z "$vsix" ]]; then
  echo "error: no .vsix file found after packaging" >&2
  exit 1
fi

echo
echo "Installing $vsix"
code --install-extension "$vsix" --force

echo
echo "Done. Reload VS Code: Cmd+Shift+P -> 'Developer: Reload Window'"
