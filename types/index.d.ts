export type TocEntry = {
  i: number
  at: string
  role: 'user' | 'command'
  uuid: string
  text: string
  source: string
  reply: { at: string; uuid: string; text: string } | null
  anchor: string | null
}

export type TocTopic = { title: string; summary: string; first: number; last: number }
export type TocCategory = { name: string; topics: TocTopic[] }
export type TocData = { categories: TocCategory[]; covered: number }

export type TocStatus = 'idle' | 'reading' | 'grouping' | 'error'

export type TocBoard = {
  sessionId: string
  entries: TocEntry[]
  toc: TocData | null
  lastAt: string | null
  builtAt: number | null
  status: TocStatus
  message?: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-toc': {
      board: TocBoard | null
      expanded: string | null
      isWrapped: boolean | null
    }
  }
}
