import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fmtStamp, jumpOf, jumpTargets, keepRecent, remember, shouldAsk, textKey } from '../hooks/register'

const entry = (i: number, text: string, at: string) => ({
  i,
  at,
  role: 'user' as const,
  uuid: `u${i}`,
  text,
  source: 'app',
  reply: { at, uuid: `r${i}`, text: `reply ${i}` },
  anchor: `toolu_${i}`,
})

const BOARD = {
  sessionId: 'sess-1',
  entries: [entry(0, 'Build a usage mod', '2026-06-07T17:19:20.683Z'), entry(1, 'Add bars', '2026-06-07T17:30:00.000Z'), entry(2, 'Run the workflow', '2026-10-08T09:14:00.000Z')],
  toc: {
    covered: 3,
    categories: [
      { name: 'Mods', topics: [{ title: 'Usage-meter mod', summary: 'Bars for plan limits', first: 0, last: 1 }] },
      { name: 'Side project', topics: [{ title: 'Quick-map workflow test', summary: 'Workflow run', first: 2, last: 2 }] },
    ],
  },
  lastAt: '2026-10-08T09:14:00.000Z',
  builtAt: 1_760_000_000_000,
  status: 'idle',
}

const PROPS = { title: 'Contents', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never

const fakeEngine = (on: On, scrolls: string[], allow: string, board: object = BOARD) => {
  const clock = mock.clock(on)
  mock.store(on, { 'toc:sess-1': board })
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { id: 'session-toc' } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.scroll', (_$, e) => {
    const to = (e as { to?: { requestId?: string } }).to
    scrolls.push(String(to?.requestId))
    return (to?.requestId === allow ? {} : { deny: 'not on screen' }) as never
  })
  return clock
}

test('timestamps read YYYY-MM-dd HH:mm:ss in local time', () => {
  expect(fmtStamp('2026-06-07T17:19:20.683Z')).toMatch(/^2026-06-0[78] \d\d:19:20$/)
  expect(fmtStamp('not a date')).toBe('not a date')
})

// The session's transcript file under a macOS home, one user row per entry.
const transcriptOf = (entries: { uuid: string; text: string; at: string }[]) =>
  entries.map(e => JSON.stringify({ type: 'user', uuid: e.uuid, timestamp: e.at, entrypoint: 'claude-desktop', message: { content: e.text } })).join('\n')
const fakeTranscript = (on: On, text: string, reads: string[], size = text.length) => {
  const path = '/Users/a/.claude/projects/-Users-a-app/sess-1.jsonl'
  mock.env(on, { HOME: '/Users/a' })
  on('fs.list', () => ({ value: [{ name: '-Users-a-app', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path === path }) as never)
  on('fs.stat', () => ({ value: { kind: 'file', size, mtimeMs: 1, isLink: false } }) as never)
  on('fs.read', (_$, e) => (reads.push(e.path), { value: text }) as never)
  return path
}

test('the pane lists categories and timestamped topics on the terminal and the app', async ($, on) => {
  fakeEngine(on, [], '')
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-toc', surface, component: 'Pane', requestId: 'session-toc', props: PROPS })
    const texts = (await ui.findAll({})).map(n => n.text).join('|')
    expect(texts).toContain('Mods')
    expect(texts).toContain('Side project')
    expect(texts).toMatch(/2026-06-0[78] \d\d:19:20/)
    expect(texts).toContain('Usage-meter mod')
    expect(texts).toContain('Bars for plan limits')
    await ui.unmount()
  }
})

test('a jump tries the message, then the reply, then the first tool call', () => {
  const e = BOARD.entries[0]
  if (!e) throw new Error('fixture')
  expect(jumpTargets(e, false)).toEqual(['u0', 'r0', 'toolu_0'])
  expect(jumpTargets(e, true)).toEqual(['r0', 'toolu_0', 'u0'])
  expect(jumpTargets({ ...e, reply: null, anchor: null }, false)).toEqual(['u0'])
  expect(jumpOf('t-4-jump')).toEqual({ index: 4, isReply: false })
  expect(jumpOf('r-7-jump')).toEqual({ index: 7, isReply: true })
  expect(jumpOf('t-4-toggle')).toBeNull()
  expect(textKey('[image] Hello   world…')).toBe('hello world')
})

test('row ids the transcript drew come before the transcript file ids', () => {
  const e = BOARD.entries[0]
  if (!e) throw new Error('fixture')
  const seen = { user: new Map<string, string>(), reply: new Map<string, string>() }
  remember(seen.user, 'Build a  usage mod', 'msg-drawn')
  remember(seen.reply, 'reply 0', 'reply-drawn')
  expect(jumpTargets(e, false, seen)).toEqual(['msg-drawn', 'u0', 'reply-drawn', 'r0', 'toolu_0'])
  expect(jumpTargets(e, true, seen)).toEqual(['reply-drawn', 'r0', 'toolu_0', 'msg-drawn', 'u0'])
})

test('a click on a time is answered by the press itself and says why when it cannot move', async ($, on) => {
  const toasts: string[] = []
  fakeEngine(on, [], '')
  on('ui.toast', (_$, e) => (toasts.push(String((e as { text?: unknown }).text)), { value: undefined }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-toc', surface: 'desktop', component: 'Pane', requestId: 'session-toc', props: PROPS })
  await ui.press({ key: 't-0-jump' })
  await ui.unmount()
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('Could not jump there: ')
})

test('clicking a time in the pane runs without error even where nothing can scroll', async ($, on) => {
  const scrolls: string[] = []
  fakeEngine(on, scrolls, '')
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-toc', surface: 'desktop', component: 'Pane', requestId: 'session-toc', props: PROPS })
  await ui.press({ key: 't-2-jump' })
  await ui.unmount()
})

test('descriptions follow the pane width and wrap when asked', async ($, on) => {
  fakeEngine(on, [], '')
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const wide = await $.ui.mount({ plugin: 'session-toc', surface: 'terminal', component: 'Pane', requestId: 'session-toc', props: { ...(PROPS as object), bodyColumns: 160 } as never })
  const wideBoxes = JSON.stringify(await wide.findAll({ type: 'Box' }))
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'session-toc', surface: 'terminal', component: 'Pane', requestId: 'session-toc', props: { ...(PROPS as object), bodyColumns: 60 } as never })
  const narrowBoxes = JSON.stringify(await narrow.findAll({ type: 'Box' }))
  await narrow.unmount()
  expect(wideBoxes).toContain('"width":135')
  expect(narrowBoxes).toContain('"width":35')
  expect(narrowBoxes).not.toContain('"width":135')
  const on1 = await $.command.run({ command: 'session-toc', args: 'wrap', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(on1.text).toContain('wrap onto several lines')
})

test('▸ expands a topic into its messages with timestamps', async ($, on) => {
  fakeEngine(on, [], '')
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-toc', surface: 'desktop', component: 'Pane', requestId: 'session-toc', props: PROPS })
  await ui.press({ key: 't-0-toggle' })
  const texts = (await ui.findAll({})).map(n => n.text).join('|')
  expect(texts).toContain('You: Build a usage mod')
  expect(texts).toContain('Claude: reply 0')
  await ui.unmount()
})

test('new talking groups only when enough messages wait, Refresh always, never without a toc unasked', () => {
  expect(shouldAsk('auto', 3, 3, 5)).toBe(false)
  expect(shouldAsk('auto', 3, 7, 5)).toBe(false)
  expect(shouldAsk('auto', 3, 8, 5)).toBe(true)
  expect(shouldAsk('auto', 3, 99, 0)).toBe(false)
  expect(shouldAsk('auto', null, 40, 5)).toBe(false)
  expect(shouldAsk('refresh', 3, 4, 5)).toBe(true)
  expect(shouldAsk('refresh', 3, 3, 5)).toBe(false)
  expect(shouldAsk('refresh', null, 4, 5)).toBe(true)
  expect(shouldAsk('rebuild', 3, 3, 5)).toBe(true)
})

test('messages not grouped yet show at once under New, newest first', async ($, on) => {
  fakeEngine(on, [], '', { ...BOARD, toc: { ...BOARD.toc, covered: 1, categories: [{ name: 'Mods', topics: [{ title: 'Usage-meter mod', summary: 'Bars', first: 0, last: 0 }] }] } })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-toc', surface: 'desktop', component: 'Pane', requestId: 'session-toc', props: PROPS })
  const texts = (await ui.findAll({})).map(n => n.text).join('|')
  await ui.unmount()
  expect(texts).toContain('New · 2 not grouped yet')
  expect(texts.indexOf('You: Run the workflow')).toBeLessThan(texts.indexOf('You: Add bars'))
  expect(texts.indexOf('New · 2')).toBeLessThan(texts.indexOf('Usage-meter mod'))
})

test('a new prompt re-reads the transcript in the background without calling Claude', async ($, on) => {
  const reads: string[] = []
  const asks: string[] = []
  const clock = fakeEngine(on, [], '')
  fakeTranscript(on, transcriptOf([...BOARD.entries, entry(3, 'Load new talk', '2026-10-08T10:00:00.000Z')]), reads)
  on('model.complete', (_$, e) => (asks.push(String((e as { prompt?: unknown }).prompt)), { value: { isAnswered: false, text: '' } }) as never)
  on('prompt.submit', (_$, e) => ({ text: (e as { text: string }).text }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Load new talk' } as never)
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'session-toc', surface: 'desktop', component: 'Pane', requestId: 'session-toc', props: PROPS })
  const texts = (await ui.findAll({})).map(n => n.text).join('|')
  await ui.unmount()
  expect(reads.length).toBeGreaterThan(0)
  expect(asks).toHaveLength(0)
  expect(texts).toContain('You: Load new talk')
  expect(texts).toContain('New · 1 not grouped yet')
})

test('a transcript over 4 MiB is streamed through cat on macOS, with no PowerShell', async ($, on) => {
  const reads: string[] = []
  const spawned: string[][] = []
  const clock = fakeEngine(on, [], '')
  const text = transcriptOf([...BOARD.entries, entry(3, 'Load new talk', '2026-10-08T10:00:00.000Z')])
  const path = fakeTranscript(on, text, reads, 30 * 1024 * 1024)
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout' as const, text: text.slice(0, 50) }
    yield { stream: 'stderr' as const, text: 'noise' }
    yield { stream: 'stdout' as const, text: text.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  on('prompt.submit', (_$, e) => ({ text: (e as { text: string }).text }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Load new talk' } as never)
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'session-toc', surface: 'desktop', component: 'Pane', requestId: 'session-toc', props: PROPS })
  const texts = (await ui.findAll({})).map(n => n.text).join('|')
  await ui.unmount()
  expect(reads).toEqual([])
  expect(spawned).toEqual([['cat', '--', path]])
  expect(texts).toContain('You: Load new talk')
})

test('after a failed background grouping the next try waits for more messages', () => {
  expect(shouldAsk('auto', 3, 8, 5, 8)).toBe(false)
  expect(shouldAsk('auto', 3, 12, 5, 8)).toBe(false)
  expect(shouldAsk('auto', 3, 13, 5, 8)).toBe(true)
  expect(shouldAsk('refresh', 3, 8, 5, 8)).toBe(true)
})

test('the cache keeps the most recent sessions and drops the rest', () => {
  expect(keepRecent(['b', 'a'], 'c', 2)).toEqual({ kept: ['c', 'b'], dropped: ['a'] })
  expect(keepRecent(['b', 'a'], 'a', 2)).toEqual({ kept: ['a', 'b'], dropped: [] })
})
