import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { TocBoard } from '../types'
import { readTranscript } from './extract'
import type { Extracted, TranscriptIO } from './extract'
import { groupEntries, topicsInOrder } from './group'
import type { Ask, Entry, Toc } from './group'

const PANE = 'session-toc'
const COMMAND = 'session-toc'
const MODEL = 'haiku'

const boardAtom = atom({ plugin: 'session-toc', key: 'board' } as const, null)
const expandedAtom = atom({ plugin: 'session-toc', key: 'expanded' } as const, null)
const wrapAtom = atom({ plugin: 'session-toc', key: 'isWrapped' } as const, null)

const TOGGLE_W = 3
const STAMP_W = 21

type $ = EngineInterface

const cacheKey = (sessionId: string) => `toc:${sessionId}`

export const fmtStamp = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const transcriptIO = ($: $): TranscriptIO => ({
  homeVars: async () => ({
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
  }),
  list: path => $.fs.list(path),
  stat: path => $.fs.stat(path),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  stream: async (argv, env, onText) => {
    const child = $.process.spawn({ argv, env })
    for await (const { stream, text } of child) if (stream === 'stdout') onText(text)
    return (await child.result).code
  },
})

const runExtract = async ($: $, sessionId: string): Promise<Extracted | { error: string }> => {
  try {
    return await readTranscript(transcriptIO($), sessionId)
  } catch (err) {
    return { error: `Cannot read the transcript: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const setBoard = ($: $, change: (b: TocBoard) => TocBoard, sessionId: string) =>
  update($, boardAtom, b =>
    change(b ?? { sessionId, entries: [], toc: null, lastAt: null, builtAt: null, status: 'idle' }),
  )

// 'auto' runs on new talking: it reads the transcript (no model) and groups only once
// `autoEvery` messages wait ungrouped; 'refresh' groups what is new; 'rebuild' regroups all.
export type BuildMode = 'auto' | 'refresh' | 'rebuild'

// `failedAt` is the message count when a background grouping last failed: the next
// background try waits for `autoEvery` more messages, so a failing call is never repeated per message.
export const shouldAsk = (mode: BuildMode, covered: number | null, total: number, autoEvery: number, failedAt: number | null = null) => {
  if (mode === 'rebuild') return total > 0
  if (covered === null) return mode === 'refresh' && total > 0
  if (mode === 'refresh') return covered < total
  if (failedAt !== null && total - failedAt < autoEvery) return false
  return autoEvery > 0 && total - covered >= autoEvery
}

let autoFailedAt: number | null = null

const RANK: Record<BuildMode, number> = { auto: 0, refresh: 1, rebuild: 2 }
let isBusy = false
let queued: BuildMode | null = null

// One build at a time; a request arriving meanwhile runs once after it (the
// strongest of those asked), so a press of Refresh is never lost to a background load.
const build = async ($: $, mode: BuildMode, autoEvery = 0): Promise<void> => {
  if (isBusy) {
    if (!queued || RANK[mode] > RANK[queued]) queued = mode
    return
  }
  isBusy = true
  try {
    await buildOnce($, mode, autoEvery)
  } finally {
    isBusy = false
  }
  const again = queued
  queued = null
  if (again) await build($, again, autoEvery)
}

const loadSoon = async ($: $, delayMs: number, autoEvery: number) => {
  try {
    if (!(await read($, boardAtom))) return
    await $.clock.sleep(delayMs)
    await build($, 'auto', autoEvery)
  } catch {
    // a background load that fails leaves the pane as it was
  }
}

const buildOnce = async ($: $, mode: BuildMode, autoEvery: number) => {
  const sessionId = await $.session.id()
  const current = await read($, boardAtom)
  const isQuiet = mode === 'auto'
  if (!isQuiet) await setBoard($, b => ({ ...b, status: 'reading', message: undefined }), sessionId)

  const extracted = await runExtract($, sessionId)
  if ('error' in extracted) {
    if (!isQuiet) await setBoard($, b => ({ ...b, status: 'error', message: extracted.error }), sessionId)
    return
  }

  const previous = mode === 'rebuild' ? null : (current?.toc ?? null)
  const usable = previous && previous.covered <= extracted.entries.length ? previous : null
  const needsAsk = shouldAsk(mode, usable ? usable.covered : null, extracted.entries.length, autoEvery, autoFailedAt)
  if (!needsAsk) {
    const kept = await setBoard(
      $,
      b => ({ ...b, sessionId, entries: extracted.entries, toc: usable, lastAt: extracted.lastAt, status: 'idle', message: undefined }),
      sessionId,
    )
    if (kept?.toc) await saveCache($, sessionId, kept)
    return
  }
  await setBoard($, b => ({ ...b, entries: extracted.entries, status: 'grouping' }), sessionId)

  const ask: Ask = async prompt => {
    const r = await $.model.complete({ model: MODEL, prompt, effort: 'low', maxTokens: 4096, timeoutMs: 180_000 })
    return r.isAnswered ? r.text : undefined
  }
  const grouped: Toc | null = await groupEntries(ask, extracted.entries, usable)
  // groupEntries hands back the previous table when the call fails: that is a failure too.
  const isStuck = grouped !== null && usable !== null && grouped.covered <= usable.covered && usable.covered < extracted.entries.length
  const toc = isStuck ? null : grouped
  autoFailedAt = toc ? null : extracted.entries.length
  const now = await $.clock.now()
  const next = await setBoard(
    $,
    b => ({
      ...b,
      sessionId,
      entries: extracted.entries,
      toc: toc ?? usable ?? b.toc,
      lastAt: extracted.lastAt,
      builtAt: toc ? now : b.builtAt,
      status: toc ? 'idle' : 'error',
      message: toc
        ? undefined
        : `Claude could not group the topics. Press Refresh to try again${autoEvery > 0 ? `, or it retries after ${autoEvery} more messages` : ''}.`,
    }),
    sessionId,
  )
  if (toc && next) await saveCache($, sessionId, next)
}

// The cache keeps the tables of the most recent sessions only, so the plugin store
// (4 MiB for all keys) never fills; a store that refuses leaves the pane working.
const KEEP_SESSIONS = 10
export const keepRecent = (index: readonly string[], sessionId: string, keep = KEEP_SESSIONS) => {
  const next = [sessionId, ...index.filter(id => id !== sessionId)]
  return { kept: next.slice(0, keep), dropped: next.slice(keep) }
}

const saveCache = async ($: $, sessionId: string, b: TocBoard) => {
  try {
    await $.store.set(cacheKey(sessionId), { entries: b.entries, toc: b.toc, lastAt: b.lastAt, builtAt: b.builtAt })
    const index = (await $.store.get('sessions')) as string[] | undefined
    const { kept, dropped } = keepRecent(Array.isArray(index) ? index : [], sessionId)
    await $.store.set('sessions', kept)
    for (const id of dropped) await $.store.delete(cacheKey(id))
  } catch {
    // the table still shows; it is just not kept for the next start
  }
}

// The transcript's own row ids, learned as rows are drawn: text prefix -> requestId.
// The transcript file's uuids are not promised to be the ids the view scrolls by.
const seenUser = new Map<string, string>()
const seenReply = new Map<string, string>()

export const textKey = (text: string) =>
  text
    .replace(/^(\[image\]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .replace(/…$/, '')
    .trim()
    .slice(0, 60)
    .toLowerCase()

export const remember = (seen: Map<string, string>, text: string, requestId: string) => {
  const k = textKey(text)
  if (k.length >= 3) seen.set(k, requestId)
}

export const jumpTargets = (entry: Entry, isReply: boolean, seen = { user: seenUser, reply: seenReply }) => {
  const user = seen.user.get(textKey(entry.text))
  const reply = entry.reply ? seen.reply.get(textKey(entry.reply.text)) : undefined
  const order = isReply
    ? [reply, entry.reply?.uuid, entry.anchor, user, entry.uuid]
    : [user, entry.uuid, reply, entry.reply?.uuid, entry.anchor]
  return [...new Set(order.filter((t): t is string => Boolean(t)))]
}

const jump = async ($: $, entry: Entry, isReply: boolean, surface?: UiPressArgument['surface']) => {
  const reasons = new Set<string>()
  for (const target of jumpTargets(entry, isReply)) {
    try {
      const r = await $.ui.scroll({ to: { requestId: target }, block: 'start' })
      if (!r.deny) return
      reasons.add(r.deny)
      if (/not scrollable/i.test(r.deny)) break
    } catch (err) {
      reasons.add(err instanceof Error ? err.message : String(err))
    }
  }
  // Where the host will not let a mod move its chat (the desktop app), hand over the
  // message's opening words so the person can find it themselves.
  if ([...reasons].some(r => /not scrollable/i.test(r))) {
    const words = (isReply && entry.reply ? entry.reply.text : entry.text).replace(/^(\[image\]\s*)+/, '').replace(/…$/, '').slice(0, 60).trim()
    const copied = await $.ui.copy({ text: words, surface }).catch(() => ({ isCopied: false }))
    $.ui.toast(
      copied.isCopied
        ? `This app does not let mods scroll its chat. Copied the message's opening words to search for: "${words}"`
        : `This app does not let mods scroll its chat (it works in the terminal's fullscreen view). The message starts: "${words}"`,
    )
    return
  }
  $.ui.toast(`Could not jump there${reasons.size ? `: ${[...reasons].join('; ')}` : '.'}`)
}

// Which message a jump button points at, from its key (t-<first>-jump, e-<i>-jump, r-<i>-jump).
export const jumpOf = (element: string) => {
  const m = /^([ter])-(\d+)-jump$/.exec(element)
  return m ? { index: Number(m[2]), isReply: m[1] === 'r' } : null
}

export const register: Register = (on, options) => {
  const wrapByDefault = options.wrapText === true
  const every = Number(options.autoGroupEvery)
  const autoEvery = Number.isFinite(every) && every >= 0 ? Math.floor(every) : 5

  // New talking: re-read the transcript in the background (no model call) once
  // the prompt is stored, and again when the reply ends so its text shows too.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    void loadSoon($, 1500, autoEvery)
    return r
  })
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    void loadSoon($, 500, autoEvery)
    return r
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Table of contents of this whole session, grouped by topic; "rebuild" regroups from scratch',
      argumentHint: '[rebuild | wrap [on|off]]',
      immediate: true,
    })
    const sessionId = await $.session.id()
    const cached = (await $.store.get(cacheKey(sessionId))) as Partial<TocBoard> | undefined
    if (cached?.toc && Array.isArray(cached.entries) && !(await read($, boardAtom))) {
      await update($, boardAtom, () => ({
        sessionId,
        entries: cached.entries ?? [],
        toc: cached.toc ?? null,
        lastAt: cached.lastAt ?? null,
        builtAt: cached.builtAt ?? null,
        status: 'idle',
      }))
    }
    return next(e)
  })

  // Watch, never change: note each transcript row's id so a jump can name it.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.component === 'UserMessage') remember(seenUser, e.props.text, e.requestId)
    return next(e)
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.component === 'AssistantMessage' && e.props.isFirstOfReply) remember(seenReply, e.props.text, e.requestId)
    return next(e)
  })

  // A transcript row moves only in answer to the person's own input, so the jump
  // runs here, inside the press, rather than in the closure drawn with the pane.
  on('ui.press', { plugin: 'session-toc' }, async ($, e, next) => {
    const target = jumpOf(e.element)
    if (!target) return next(e)
    const entry = (await read($, boardAtom))?.entries[target.index]
    if (entry) await jump($, entry, target.isReply, e.surface)
    return { element: e.element }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'wrap' || arg === 'wrap on' || arg === 'wrap off') {
      const isOn = arg === 'wrap' ? !((await read($, wrapAtom)) ?? wrapByDefault) : arg === 'wrap on'
      await update($, wrapAtom, () => isOn)
      await $.ui.open({ id: PANE, title: 'Contents' })
      return { text: isOn ? 'Descriptions now wrap onto several lines.' : 'Descriptions now stay on one line.' }
    }
    const isFull = arg === 'rebuild'
    await $.ui.open({ id: PANE, title: 'Contents' })
    void build($, isFull ? 'rebuild' : 'refresh', autoEvery)
    const board = await read($, boardAtom)
    const topics = board?.toc ? topicsInOrder(board.toc).length : 0
    return {
      text: isFull
        ? 'Rebuilding the table of contents with one Claude call…'
        : topics
          ? `Table of contents opened (${topics} topics); checking for new messages.`
          : 'Building the table of contents: reading the transcript, then one Claude call to group topics…',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Button = 'Button' in els ? els.Button : undefined
    const board = await read($, boardAtom)
    const expanded = await read($, expandedAtom)
    const entries = board?.entries ?? []
    const toc = board?.toc ?? null
    const rows = []

    const isWrapped = (await read($, wrapAtom)) ?? wrapByDefault
    const wrap = isWrapped ? 'wrap' : 'truncate-end'
    const descW = Math.max(20, e.props.bodyColumns - TOGGLE_W - STAMP_W - 1)

    const action = (key: string, label: string, onPress: () => Promise<unknown>) =>
      Button ? <Button key={key} label={label} onPress={onPress} /> : <Text key={key} dimColor>{`[${label}]`}</Text>

    // The press itself is answered by the ui.press hook above (jumpOf reads the key).
    const stamp = (key: string, iso: string, isDim = false) => (
      <Box key={`${key}-stamp`} width={STAMP_W} flexShrink={0}>
        {Button ? <Button key={key} plain dimColor={isDim} label={fmtStamp(iso)} onPress={() => undefined} /> : <Text dimColor={isDim}>{fmtStamp(iso)}</Text>}
      </Box>
    )

    const desc = (key: string, text: string, style: { isBold?: boolean; isDim?: boolean } = {}) => (
      <Box key={key} width={descW} flexShrink={1}>
        <Text bold={style.isBold} dimColor={style.isDim} wrap={wrap}>{text}</Text>
      </Box>
    )

    const entryRows = (entry: Entry) => {
      const who = entry.role === 'command' ? 'Command' : 'You'
      const out = [
        <Box key={`e-${entry.i}`} alignItems="flex-start">
          {pad(`e-${entry.i}-pad`, TOGGLE_W)}
          {stamp(`e-${entry.i}-jump`, entry.at)}
          {desc(`e-${entry.i}-text`, `${who}: ${entry.text}`)}
        </Box>,
      ]
      const reply = entry.reply
      if (reply) {
        out.push(
          <Box key={`r-${entry.i}`} alignItems="flex-start">
            {pad(`r-${entry.i}-pad`, TOGGLE_W)}
            {stamp(`r-${entry.i}-jump`, reply.at, true)}
            {desc(`r-${entry.i}-text`, `Claude: ${reply.text}`, { isDim: true })}
          </Box>,
        )
      }
      return out
    }

    const pad = (key: string, width: number) => (
      <Box key={key} width={width} flexShrink={0}>
        <Text> </Text>
      </Box>
    )

    const topics = toc ? topicsInOrder(toc) : []
    rows.push(
      <Box key="head">
        <Text bold>Session contents </Text>
        <Text dimColor wrap={wrap}>
          {toc
            ? `· ${topics.length} topics · ${toc.categories.length} categories · ${entries.length} messages since ${entries[0] ? fmtStamp(entries[0].at) : '—'}`
            : '· not built yet'}
        </Text>
      </Box>,
    )
    rows.push(
      <Box key="actions">
        {action('refresh', 'Refresh', () => build($, 'refresh', autoEvery))}
        <Text> </Text>
        {action('rebuild', 'Rebuild', () => build($, 'rebuild', autoEvery))}
        <Text> </Text>
        {action('wrap', isWrapped ? 'Single line' : 'Wrap', () => update($, wrapAtom, v => !(v ?? wrapByDefault)))}
      </Box>,
    )
    if (board?.status === 'reading') rows.push(<Text key="status" color="cyan">Reading the transcript…</Text>)
    if (board?.status === 'grouping') rows.push(<Text key="status" color="cyan">Grouping topics with Claude (one call)…</Text>)
    if (board?.status === 'error') rows.push(<Text key="status" color="red" wrap="wrap">{board.message ?? 'Something went wrong.'}</Text>)
    if (!toc && entries.length === 0 && board?.status !== 'reading' && board?.status !== 'grouping') {
      rows.push(<Text key="empty" dimColor wrap="wrap">Press Refresh to build the table of contents. It reads this session's transcript and makes one Claude call to group the topics.</Text>)
    }

    // Messages read since the last grouping: shown at once, filed into topics later.
    const fresh = entries.slice(toc ? toc.covered : 0)
    if (fresh.length > 0) {
      rows.push(<Text key="gap-new"> </Text>)
      rows.push(
        <Text key="cat-new" bold color="yellow" wrap={wrap}>
          {`New · ${fresh.length} not grouped yet${toc && autoEvery > 0 ? ` (grouped at ${autoEvery}, or press Refresh)` : ' (press Refresh to group)'}`}
        </Text>,
      )
      for (const entry of [...fresh].reverse()) rows.push(...entryRows(entry))
    }

    if (toc) {
      for (const category of toc.categories) {
        rows.push(<Text key={`gap-${category.name}`}> </Text>)
        rows.push(<Text key={`cat-${category.name}`} bold color="cyan" wrap={wrap}>{category.name}</Text>)
        for (const topic of [...category.topics].sort((a, b) => a.first - b.first)) {
          const start = entries[topic.first]
          if (!start) continue
          const key = `t-${topic.first}`
          const isOpen = expanded === key
          rows.push(
            <Box key={key} alignItems="flex-start">
              <Box key={`${key}-tog`} width={TOGGLE_W} flexShrink={0}>
                {action(`${key}-toggle`, isOpen ? '▾' : '▸', () => update($, expandedAtom, v => (v === key ? null : key)))}
              </Box>
              {stamp(`${key}-jump`, start.at)}
              {desc(`${key}-title`, topic.title, { isBold: true })}
            </Box>,
          )
          rows.push(
            <Box key={`${key}-sum`} alignItems="flex-start">
              {pad(`${key}-sum-pad`, TOGGLE_W + STAMP_W)}
              {desc(`${key}-sum-text`, topic.summary, { isDim: true })}
            </Box>,
          )
          if (!isOpen) continue
          for (const entry of entries.slice(topic.first, topic.last + 1)) rows.push(...entryRows(entry))
        }
      }
    }

    if (toc || fresh.length > 0) {
      rows.push(<Text key="gap-foot"> </Text>)
      rows.push(
        <Text key="foot" dimColor wrap="wrap">
          {`Click a time to jump there, ▸ to list a topic's messages. Built ${board?.builtAt ? fmtStamp(new Date(board.builtAt).toISOString()) : '—'}; new messages load by themselves as you talk; Refresh only sends new messages to Claude.`}
        </Text>,
      )
    }
    return <Box flexDirection="column">{rows}</Box>
  })
}
