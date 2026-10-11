import type { Entry } from './group'

// Reads the session's transcript (JSONL) into the entries the pane lists: what the
// person typed, each with the first words of Claude's reply. Pure TypeScript, so it
// runs the same on Windows, macOS and Linux; nothing has to be installed.

export type Extracted = { entries: Entry[]; firstAt: string | null; lastAt: string | null }

const MAX_CHARS = 300
const ELLIPSIS = String.fromCharCode(0x2026)

const SKIP_PREFIXES = [
  '<local-command-caveat',
  '<local-command-stdout',
  '<local-command-stderr',
  '<system-reminder',
  '<task-notification',
  '[SYSTEM NOTIFICATION',
  'Another Claude session sent a message',
  '[Request interrupted',
]

const RE_TS = /"timestamp"\s*:\s*"(\d{4}-\d\d-\d\dT[^"]+)"/
const RE_SYS_REM = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const RE_CMD_NAME = /<command-name>\s*([\s\S]*?)\s*<\/command-name>/
const RE_CMD_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

export const clip = (s: string | null | undefined, max = MAX_CHARS) => {
  if (s === null || s === undefined) return ''
  let t = s.replace(/\s+/g, ' ').trim()
  if (t.length > max) {
    let n = Math.max(0, max - 1)
    if (n > 0 && isHighSurrogate(t.charCodeAt(n - 1))) n--
    t = t.slice(0, n) + ELLIPSIS
  }
  return t
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const sourceOf = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return s === 'claude-desktop' ? 'app' : s
}
const squash = (s: string) => s.replace(/\s+/g, ' ')
const chomp = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line)

type Row = {
  type?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  isVisibleInTranscriptOnly?: unknown
  timestamp?: unknown
  uuid?: unknown
  entrypoint?: unknown
  message?: { content?: unknown } | null
  attachment?: { type?: unknown; prompt?: unknown; origin?: { kind?: unknown } | null } | null
}
type Block = { type?: unknown; text?: unknown; id?: unknown } | null

// A queued prompt is text, or blocks when it carries an image: shown as the
// matching user row would be, so that row is recognised as the same message.
const promptText = (p: unknown) => {
  if (!Array.isArray(p)) return str(p) ?? ''
  const blocks = p as Block[]
  const images = blocks.filter(b => b?.type === 'image').length
  const texts = blocks.filter(b => b?.type === 'text').map(b => str(b?.text) ?? '')
  return '[image] '.repeat(images) + texts.join(' ')
}

// Feed it the transcript one line at a time, then `finish()`.
export const createExtractor = () => {
  let firstAt: string | null = null
  let lastAt: string | null = null
  const entries: Entry[] = []
  let cur: Entry | null = null // the entry collecting its reply and anchor
  const queued = new Set<string>()

  const push = (line: string) => {
    if (line.length < 2) return
    const m = RE_TS.exec(line)
    if (m) {
      if (firstAt === null) firstAt = m[1] ?? null
      lastAt = m[1] ?? lastAt
    }

    const isUser = line.includes('"type":"user"')
    const isAsst = line.includes('"type":"assistant"')
    const isQueued = line.includes('"queued_command"')
    if (!(isUser || isAsst || isQueued)) return
    let o: Row
    try {
      o = JSON.parse(line) as Row
    } catch {
      return
    }
    if (o === null || typeof o !== 'object') return
    const type = str(o.type) ?? ''
    if (o.isSidechain === true) return

    // A message typed while Claude is mid-turn is stored as a queued_command attachment, not a user row.
    if (type === 'attachment') {
      const a = o.attachment
      if (!a || a.type !== 'queued_command' || a.origin?.kind !== 'human') return
      const qtext = promptText(a.prompt).replace(RE_SYS_REM, ' ').trim()
      if (qtext.length === 0) return
      queued.add(squash(qtext))
      cur = { i: entries.length, at: str(o.timestamp) ?? '', role: 'user', uuid: str(o.uuid) ?? '', text: clip(qtext), source: sourceOf(o.entrypoint), reply: null, anchor: null }
      entries.push(cur)
      return
    }
    if (type !== 'user' && type !== 'assistant') return

    const ts = str(o.timestamp)
    if (ts && firstAt === null) firstAt = ts
    const content = o.message ? o.message.content : null

    if (type === 'user') {
      if (o.isMeta === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return
      const texts: (string | null)[] = []
      let images = 0
      if (typeof content === 'string') texts.push(content)
      else if (content !== null && content !== undefined) {
        for (const b of (Array.isArray(content) ? content : [content]) as Block[]) {
          if (!b) continue
          if (b.type === 'text') texts.push(str(b.text))
          else if (b.type === 'image') images++
        }
      }
      let role: Entry['role'] = 'user'
      let parts: string[] = []
      for (const t of texts) {
        if (t === null) continue
        let tt = t.trimStart()
        const cm = RE_CMD_NAME.exec(tt)
        if (tt.startsWith('<command-name>') || (tt.startsWith('<command-message>') && cm)) {
          role = 'command'
          let name = (cm?.[1] ?? '').trim()
          if (!name.startsWith('/')) name = '/' + name
          const am = RE_CMD_ARGS.exec(tt)
          parts = [`${name} ${(am?.[1] ?? '').trim()}`.trim()]
          break
        }
        if (SKIP_PREFIXES.some(p => tt.startsWith(p))) continue
        tt = tt.replace(RE_SYS_REM, ' ').trim()
        if (tt.length > 0) parts.push(tt)
      }
      let txt: string
      if (role === 'user') {
        if (parts.length === 0 && images === 0) return
        txt = '[image] '.repeat(images) + parts.join(' ')
        if (queued.delete(squash(txt).trim())) return
      } else txt = parts[0] ?? ''

      cur = { i: entries.length, at: ts ?? '', role, uuid: str(o.uuid) ?? '', text: clip(txt), source: sourceOf(o.entrypoint), reply: null, anchor: null }
      entries.push(cur)
      return
    }

    // assistant
    if (cur === null || content === null || content === undefined || typeof content === 'string') {
      if (cur !== null && typeof content === 'string' && cur.reply === null && content.trim().length > 0) {
        cur.reply = { at: ts ?? '', uuid: str(o.uuid) ?? '', text: clip(content) }
      }
      return
    }
    for (const b of (Array.isArray(content) ? content : [content]) as Block[]) {
      if (!b) continue
      if (b.type === 'text' && cur.reply === null) {
        const bt = str(b.text)
        if (bt && bt.trim().length > 0) cur.reply = { at: ts ?? '', uuid: str(o.uuid) ?? '', text: clip(bt) }
      } else if (b.type === 'tool_use' && cur.anchor === null) cur.anchor = str(b.id)
    }
  }

  const finish = (): Extracted => ({ entries, firstAt, lastAt })
  return { push, finish }
}

export const extractText = (text: string): Extracted => {
  const x = createExtractor()
  for (const line of text.split('\n')) x.push(chomp(line))
  return x.finish()
}

// ---- finding and reading the transcript ----

// What reading needs from the engine; register.tsx builds it from `$`.
export type TranscriptIO = {
  homeVars: () => Promise<HomeVars>
  list: (path: string) => Promise<readonly { name: string; kind: string }[]>
  stat: (path: string) => Promise<{ kind: string; size: number; mtimeMs: number }>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  // Runs argv, hands each piece of its standard output to `onText`, resolves its exit code.
  stream: (argv: string[], env: Record<string, string>, onText: (text: string) => void) => Promise<number | null>
}

const trimEnd = (p: string) => p.replace(/[\\/]+$/, '')

// Where Claude Code keeps its files: CLAUDE_CONFIG_DIR, else ~/.claude. On Windows the
// home folder is USERPROFILE (HOME may be a Git Bash one), elsewhere HOME.
export type HomeVars = { CLAUDE_CONFIG_DIR?: string; USERPROFILE?: string; HOME?: string }
export const configDirs = (env: HomeVars) => {
  if (env.CLAUDE_CONFIG_DIR) return [trimEnd(env.CLAUDE_CONFIG_DIR)]
  const homes = [env.USERPROFILE, env.HOME].filter((h): h is string => !!h).map(trimEnd)
  return [...new Set(homes)].map(h => `${h}/.claude`)
}

let found: { sessionId: string; path: string } | null = null

export const findTranscript = async (io: TranscriptIO, sessionId: string): Promise<string | { error: string }> => {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return { error: `Invalid session id: ${sessionId}` }
  if (found?.sessionId === sessionId && (await io.exists(found.path).catch(() => false))) return found.path
  const dirs = configDirs(await io.homeVars())
  let best: { path: string; mtimeMs: number } | null = null
  for (const base of dirs) {
    const projects = `${base}/projects`
    let listed
    try {
      listed = await io.list(projects)
    } catch {
      continue
    }
    const hits = await Promise.all(
      listed
        .filter(d => d.kind === 'dir')
        .map(async d => {
          const path = `${projects}/${d.name}/${sessionId}.jsonl`
          try {
            const s = await io.stat(path)
            return s.kind === 'file' ? { path, mtimeMs: s.mtimeMs } : null
          } catch {
            return null
          }
        }),
    )
    for (const h of hits) if (h && (!best || h.mtimeMs > best.mtimeMs)) best = h
    if (best) break
  }
  if (!best) return { error: `Transcript not found for session ${sessionId} under ${dirs.map(d => `${d}/projects`).join(' or ') || '~/.claude/projects'}.` }
  found = { sessionId, path: best.path }
  return best.path
}

// `$.fs.read` takes files up to 4 MiB; a longer transcript is streamed through a
// child process instead, which has no size limit: `cat` on macOS and Linux,
// Windows PowerShell (built in) on Windows. The file is opened for shared reading,
// so Claude Code can keep appending to it meanwhile.
const READ_LIMIT = 4 * 1024 * 1024 - 64 * 1024
const PS_COPY =
  "$f=[IO.File]::Open($env:SESSION_TOC_PATH,'Open','Read','ReadWrite');$o=[Console]::OpenStandardOutput();$f.CopyTo($o);$o.Flush();$f.Close()"

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

export const streamCommands = (path: string): string[][] => {
  const ps = (shell: string) => [shell, '-NoProfile', '-NonInteractive', '-Command', PS_COPY]
  return isWindowsPath(path) ? [ps('powershell'), ps('pwsh'), ['cat', '--', path]] : [['cat', '--', path]]
}

const streamWith = async (io: TranscriptIO, argv: string[], path: string): Promise<Extracted | null> => {
  const x = createExtractor()
  let rest = ''
  try {
    const code = await io.stream(argv, { SESSION_TOC_PATH: path }, text => {
      const lines = (rest + text).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) x.push(chomp(line))
    })
    if (code !== 0) return null
  } catch {
    return null
  }
  if (rest) x.push(chomp(rest))
  return x.finish()
}

export const readTranscript = async (io: TranscriptIO, sessionId: string): Promise<Extracted | { error: string }> => {
  const path = await findTranscript(io, sessionId)
  if (typeof path !== 'string') return path
  let size: number
  try {
    size = (await io.stat(path)).size
  } catch {
    found = null
    return { error: `Cannot read the transcript: ${path}` }
  }
  if (size <= READ_LIMIT) {
    try {
      return extractText(await io.read(path))
    } catch {
      // grew past the limit since the stat: stream it below
    }
  }
  for (const argv of streamCommands(path)) {
    const r = await streamWith(io, argv, path)
    if (r) return r
  }
  return { error: `Cannot read the transcript (${Math.round(size / 1048576)} MB): ${path}` }
}
