// Messages exchanged between the extension host and the webview.

export interface Crumb {
  label: string
  // Path relative to the workspace root, used as a stable id when popping back.
  key: string
}

export type ToWebview =
  | {
      type: 'render'
      file: { name: string; content: string; path: string }
      breadcrumbs: Crumb[]
      canGoBack: boolean
    }
  | { type: 'show-error'; message: string }

export type FromWebview =
  | { type: 'navigate'; target: string }
  | { type: 'pop-to'; index: number }
  | { type: 'back' }
  | { type: 'reveal-source' }
  | { type: 'check-coverage' }
  | { type: 'ready' }
