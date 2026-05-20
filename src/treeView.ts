import * as vscode from 'vscode'
import * as path from 'path'
import { parseMarkdown } from './parse'

interface DiagramNode {
  uri: vscode.Uri
  label: string
  // URI strings of every ancestor on the path from the root to this node's
  // parent. Used to break cycles: if a child URI is already in this set, we
  // surface it as a non-expandable leaf rather than recursing forever.
  ancestors: Set<string>
  isCycle: boolean
}

export class CodeswimTreeProvider implements vscode.TreeDataProvider<DiagramNode> {
  private _onDidChange = new vscode.EventEmitter<DiagramNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event

  constructor(private folder: () => vscode.WorkspaceFolder | null) {}

  refresh(): void {
    this._onDidChange.fire(undefined)
  }

  getTreeItem(node: DiagramNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.isCycle
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed
    )
    item.resourceUri = node.uri
    item.iconPath = new vscode.ThemeIcon(node.isCycle ? 'sync' : 'symbol-structure')
    if (node.isCycle) {
      item.description = '(cycle)'
      item.tooltip = `${node.uri.fsPath}\n\nAlready expanded earlier in this branch.`
    } else {
      item.tooltip = node.uri.fsPath
    }
    item.command = {
      command: 'codeswim.showPreview',
      title: 'Open',
      arguments: [node.uri]
    }
    return item
  }

  async getChildren(node?: DiagramNode): Promise<DiagramNode[]> {
    const folder = this.folder()
    if (!folder) return []
    if (!node) {
      const overview = vscode.Uri.joinPath(folder.uri, 'overview.md')
      try {
        await vscode.workspace.fs.stat(overview)
      } catch {
        return []
      }
      return [
        {
          uri: overview,
          label: 'overview',
          ancestors: new Set(),
          isCycle: false
        }
      ]
    }
    if (node.isCycle) return []
    return this.childrenOf(node)
  }

  private async childrenOf(parent: DiagramNode): Promise<DiagramNode[]> {
    let text: string
    try {
      const bytes = await vscode.workspace.fs.readFile(parent.uri)
      text = new TextDecoder('utf-8').decode(bytes)
    } catch {
      return []
    }
    const parsed = parseMarkdown(text)
    const mermaid = parsed.mermaidBlocks[0] ?? ''
    const targets = extractNavigateTargets(mermaid)

    const parentKey = parent.uri.toString()
    const childAncestors = new Set(parent.ancestors)
    childAncestors.add(parentKey)
    const baseDir = path.dirname(parent.uri.fsPath)

    const seenInSiblings = new Set<string>()
    const out: DiagramNode[] = []
    for (const target of targets) {
      const cleaned = target.split('#')[0].split('?')[0]
      if (!cleaned.endsWith('.md')) continue
      const childUri = vscode.Uri.file(path.resolve(baseDir, cleaned))
      const key = childUri.toString()
      if (seenInSiblings.has(key)) continue
      seenInSiblings.add(key)
      try {
        await vscode.workspace.fs.stat(childUri)
      } catch {
        continue
      }
      out.push({
        uri: childUri,
        label: path.basename(childUri.fsPath, '.md'),
        ancestors: childAncestors,
        isCycle: childAncestors.has(key)
      })
    }
    return out
  }
}

const NAV_RE = /\bnavigate\(\s*["']([^"'\n]+)["']\s*\)/g

function extractNavigateTargets(mermaid: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = NAV_RE.exec(mermaid)) !== null) out.push(m[1])
  return out
}
