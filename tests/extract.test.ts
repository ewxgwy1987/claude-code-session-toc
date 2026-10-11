import { expect, test } from 'claude-code/testing'
import type { TranscriptIO } from '../hooks/extract'

import { clip, configDirs, extractText, readTranscript, streamCommands } from '../hooks/extract'

const row = (o: object) => JSON.stringify(o)
const user = (uuid: string, at: string, content: unknown, extra: object = {}) =>
  row({ type: 'user', uuid, timestamp: at, entrypoint: 'claude-desktop', message: { role: 'user', content }, ...extra })
const reply = (uuid: string, at: string, content: unknown, extra: object = {}) =>
  row({ type: 'assistant', uuid, timestamp: at, message: { role: 'assistant', content }, ...extra })

const T1 = '2026-10-10T08:00:00.000Z'
const T2 = '2026-10-10T08:00:05.000Z'
const T3 = '2026-10-10T08:01:00.000Z'
const T4 = '2026-10-10T08:01:09.000Z'

const TRANSCRIPT = [
  row({ type: 'summary', timestamp: '2026-10-10T07:59:59.000Z' }),
  user('u1', T1, 'Fix the  login\nbug'),
  reply('a1', T2, [{ type: 'tool_use', id: 'toolu_1', name: 'Read' }]),
  reply('a2', T2, [{ type: 'text', text: 'Found it in auth.ts.' }, { type: 'tool_use', id: 'toolu_2' }]),
  reply('a3', T2, [{ type: 'text', text: 'A later reply is not the first one.' }]),
  user('m1', T2, 'injected', { isMeta: true }),
  user('s1', T2, '<system-reminder>internal</system-reminder>'),
  user('side', T2, 'a subagent prompt', { isSidechain: true }),
  user('c1', T3, '<command-name>/session-toc</command-name>\n<command-message>session-toc</command-message>\n<command-args> rebuild </command-args>'),
  user('t1', T3, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text' }]),
  user('u2', T3, [{ type: 'image', source: {} }, { type: 'text', text: 'What is <system-reminder>x</system-reminder>this?' }]),
  reply('a4', T4, 'A plain string reply'),
  'not json at all {"type":"user"',
  '',
].join('\n')

test('the transcript becomes entries: prompts, commands, first replies and anchors', () => {
  const x = extractText(TRANSCRIPT)
  expect(x.firstAt).toBe('2026-10-10T07:59:59.000Z')
  expect(x.lastAt).toBe(T4)
  expect(x.entries).toEqual([
    { i: 0, at: T1, role: 'user', uuid: 'u1', text: 'Fix the login bug', source: 'app', reply: { at: T2, uuid: 'a2', text: 'Found it in auth.ts.' }, anchor: 'toolu_1' },
    { i: 1, at: T3, role: 'command', uuid: 'c1', text: '/session-toc rebuild', source: 'app', reply: null, anchor: null },
    { i: 2, at: T3, role: 'user', uuid: 'u2', text: '[image] What is this?', source: 'app', reply: { at: T4, uuid: 'a4', text: 'A plain string reply' }, anchor: null },
  ])
})

test('a message typed mid-turn is listed once, from its queued copy, image or not', () => {
  const queued = (uuid: string, prompt: unknown) =>
    row({ type: 'attachment', uuid, timestamp: T1, entrypoint: 'cli', attachment: { type: 'queued_command', prompt, origin: { kind: 'human' } } })
  const x = extractText(
    [
      queued('q1', 'Also   check the tests'),
      user('u1', T2, 'Also check the tests'),
      queued('q2', [{ type: 'image', source: {} }, { type: 'text', text: 'Look at this' }]),
      user('u2', T2, [{ type: 'image', source: {} }, { type: 'text', text: 'Look at this' }]),
      row({ type: 'attachment', uuid: 'q3', timestamp: T1, attachment: { type: 'queued_command', prompt: 'from a task', origin: { kind: 'task-notification' } } }),
    ].join('\r\n'),
  )
  expect(x.entries.map(e => [e.uuid, e.text, e.source])).toEqual([
    ['q1', 'Also check the tests', 'cli'],
    ['q2', '[image] Look at this', 'cli'],
  ])
})

test('long text is cut to 300 characters with an ellipsis, never inside a surrogate pair', () => {
  expect(clip('x'.repeat(301))).toBe('x'.repeat(299) + '\u2026')
  expect(clip('x'.repeat(300))).toBe('x'.repeat(300))
  expect(clip('x'.repeat(298) + '\u{1F600}' + 'y')).toBe('x'.repeat(298) + '\u2026')
})

test('the config folder: CLAUDE_CONFIG_DIR first, else the home folder on every OS', () => {
  expect(configDirs({ CLAUDE_CONFIG_DIR: '/custom/', HOME: '/Users/a' })).toEqual(['/custom'])
  expect(configDirs({ HOME: '/Users/a' })).toEqual(['/Users/a/.claude'])
  expect(configDirs({ HOME: '/home/a/' })).toEqual(['/home/a/.claude'])
  expect(configDirs({ USERPROFILE: 'C:\\Users\\a', HOME: '/c/Users/a' })).toEqual(['C:\\Users\\a/.claude', '/c/Users/a/.claude'])
  expect(configDirs({})).toEqual([])
})

test('a long transcript streams through cat on macOS and Linux, PowerShell first on Windows', () => {
  expect(streamCommands('/Users/a/.claude/projects/p/s.jsonl')).toEqual([['cat', '--', '/Users/a/.claude/projects/p/s.jsonl']])
  const win = streamCommands('C:\\Users\\a\\.claude\\projects\\p\\s.jsonl')
  expect(win.map(c => c[0])).toEqual(['powershell', 'pwsh', 'cat'])
  expect((win[0] ?? []).join(' ')).not.toContain('Users')
})

// A macOS home with two project folders; the session's file is in the second.
const PATH = '/Users/a/.claude/projects/-Users-a-app/sess-1.jsonl'
const fakeIO = (size: number, log: { reads: string[]; spawned: string[][] }, pieces: string[] = [TRANSCRIPT]): TranscriptIO => ({
  homeVars: async () => ({ HOME: '/Users/a' }),
  list: async path => {
    if (path !== '/Users/a/.claude/projects') throw new Error('ENOENT')
    return [{ name: '-Users-a-other', kind: 'dir' }, { name: '-Users-a-app', kind: 'dir' }, { name: 'notes.txt', kind: 'file' }]
  },
  stat: async path => {
    if (path !== PATH) throw new Error('ENOENT')
    return { kind: 'file', size, mtimeMs: 1 }
  },
  exists: async path => path === PATH,
  read: async path => {
    log.reads.push(path)
    if (size > 4 * 1024 * 1024) throw new Error('over 4 MiB')
    return TRANSCRIPT
  },
  stream: async (argv, _env, onText) => {
    log.spawned.push(argv)
    for (const p of pieces) onText(p)
    return 0
  },
})

test('a small transcript is found under ~/.claude/projects and read directly', async () => {
  const log = { reads: [] as string[], spawned: [] as string[][] }
  const x = await readTranscript(fakeIO(2_000, log), 'sess-1')
  expect(log).toEqual({ reads: [PATH], spawned: [] })
  expect('error' in x ? x.error : x.entries.map(e => e.uuid)).toEqual(['u1', 'c1', 'u2'])
})

test('a transcript over 4 MiB is streamed through cat, lines split across pieces', async () => {
  const log = { reads: [] as string[], spawned: [] as string[][] }
  const cut = TRANSCRIPT.indexOf('login') + 2
  const x = await readTranscript(fakeIO(30 * 1024 * 1024, log, [TRANSCRIPT.slice(0, cut), TRANSCRIPT.slice(cut)]), 'sess-1')
  expect(log).toEqual({ reads: [], spawned: [['cat', '--', PATH]] })
  expect('error' in x ? x.error : x.entries.map(e => e.text)).toEqual(['Fix the login bug', '/session-toc rebuild', '[image] What is this?'])
})

test('a missing transcript says where it looked', async () => {
  const io: TranscriptIO = { ...fakeIO(0, { reads: [], spawned: [] }), homeVars: async () => ({ HOME: '/home/a' }), list: async () => [] }
  expect(await readTranscript(io, 'nope')).toEqual({ error: 'Transcript not found for session nope under /home/a/.claude/projects.' })
  expect(await readTranscript(io, '../etc')).toEqual({ error: 'Invalid session id: ../etc' })
})
