# session-toc

A table of contents for your whole Claude Code session, in a pane.

The **Contents** pane lists every topic you have talked about in the current
session. Topics are grouped into categories. Each topic shows the time it
started, a bold title and a dim one-line summary. Press **▸** to list the
messages inside a topic. New messages appear by themselves as you talk.

For everyday use, read the [user manual](MANUAL.md). This README is the full
reference, including how the mod works inside.

```
Session contents · 9 topics · 3 categories · 41 messages since 2026-06-01 09:05:12
[Refresh] [Rebuild] [Wrap]

New · 2 not grouped yet (grouped at 5, or press Refresh)
   2026-06-01 15:42:10  You: Add a dark theme to the settings page
                        Claude: I'll add a theme toggle that stores the choice…
   2026-06-01 15:30:02  Command: /compact

Backend
▸  2026-06-01 09:05:12  Database migration script
                        Wrote and tested a migration that adds the orders table
▾  2026-06-01 11:20:47  Fix login timeout
                        Raised the session timeout and added a retry on refresh
   2026-06-01 11:20:47  You: Users get logged out after five minutes
   2026-06-01 11:21:03  Claude: The timeout comes from the token refresh…
   2026-06-01 11:48:30  Command: /review

Frontend
▸  2026-06-01 13:02:15  Settings page layout
                        Moved the form into two columns and fixed spacing

Click a time to jump there, ▸ to list a topic's messages. Built 2026-06-01 15:28:40; ...
```

Times are shown as `YYYY-MM-dd HH:mm:ss` in your local time zone.

## Requirements

- A Claude Code build that supports **function-hook plugins** (plugins with a
  `hooks/hooks.json` that lists TypeScript modules). This plugin was built and
  tested with Claude Code **2.1.289**.
- **Windows, macOS or Linux.** Nothing else to install: the mod reads the
  transcript itself. A transcript over 4 MiB is streamed through a tool every
  system already has: `cat` on macOS and Linux, the built-in Windows
  PowerShell on Windows.
- Grouping uses the Haiku model through your normal Claude Code login. It needs
  no API key of its own.

## Install

The repository root is the plugin. Clone it:

```sh
git clone https://github.com/ewxgwy1987/claude-code-session-toc.git
```

Then pick one way of loading it.

**A. One session.** Start Claude Code with:

```sh
claude --plugin-dir /path/to/claude-code-session-toc
```

**B. Every session**, including the desktop app and Remote Control sessions
started on that machine. Add this to your **user** settings,
`~/.claude/settings.json`. Project settings are ignored for this setting.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-session-toc"
  }
}
```

- The path must be absolute; `~` is allowed.
- On Windows forward slashes work, for example `C:/mods/claude-code-session-toc`.
- Separate several paths with `;` on Windows and `:` elsewhere.
- If you keep several mod clones side by side in one folder, you can name that
  folder instead. Each clone inside it is loaded.
- Start a new session afterwards.

**C. Plugin marketplace.** The repository is also a marketplace:

```
/plugin marketplace add ewxgwy1987/claude-code-session-toc
/plugin install session-toc@claude-code-session-toc
```

To check that it loaded, type `/session-toc`. The **Contents** pane should
open.

## Usage

### Opening the pane

Type `/session-toc`. The pane opens with the title **Contents**. The command
runs immediately, even while Claude is busy.

| Command | What it does |
|---|---|
| `/session-toc` | Opens the pane and checks for new messages. Groups anything not yet grouped (one Haiku call, only if there is something new). |
| `/session-toc rebuild` | Opens the pane and regroups the whole session from scratch (one Haiku call). |
| `/session-toc wrap` | Switches between wrapped and single-line text. |
| `/session-toc wrap on` / `wrap off` | Turns wrapping on or off. |

### First build

Nothing is grouped until you ask. The first `/session-toc` (or the first press
of **Refresh**) reads the transcript and makes one Haiku call to group it.
While it works the pane shows "Reading the transcript…" and then "Grouping
topics with Claude (one call)…". After that, the result is saved and comes back
by itself when you resume the session.

### Buttons

- **Refresh** — reads the transcript again. If there are messages that are not
  yet in a topic, it sends **only those** to Haiku and files them into the
  existing topics and categories. If nothing is new, no call is made.
- **Rebuild** — regroups every message from scratch with one Haiku call. Use it
  when the categories no longer fit.
- **Wrap / Single line** — shows long titles, summaries and messages in full
  over several lines, or cuts them to one line.

### The New section

New messages show up at the top of the pane in a yellow section,
"New · N not grouped yet", newest first. This happens without any model call.
Once `autoGroupEvery` messages are waiting, one Haiku call files them into
topics and the section empties. You can also press **Refresh** at any time.

### Expanding a topic

Press **▸** next to a topic to list its messages. Press **▾** to close it. Only
one topic is open at a time. Each message row has its own timestamp:

- `You: …` — a prompt you typed (including messages typed while Claude was
  still working).
- `Command: …` — a slash command and its arguments.
- `Claude: …` (dim) — the start of Claude's first text reply to that message.

### Clicking a timestamp

Every timestamp is a button that tries to scroll the chat to that message.
Read the "Jumping" section below: in many places the host does not allow it,
and the click copies the message's opening words instead.

### Options

Two options are declared in `plugin.json` (`userConfig`). Change them in
`/config`. They are stored in `settings.json` under
`pluginConfigs["session-toc"].options`. Changing an option reloads the plugin.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `wrapText` | boolean | `false` | Start with wrapped text instead of single lines. The Wrap button and `/session-toc wrap` override it for the current session. |
| `autoGroupEvery` | number | `5` | Group new messages automatically once this many are waiting. `0` means only when you press Refresh or run `/session-toc`. |

## How it works

### 1. Reading the transcript (no model call)

`hooks/extract.ts` reads the session's transcript file:
`~/.claude/projects/<project>/<sessionId>.jsonl`, or the same path under
`CLAUDE_CONFIG_DIR` when that variable is set. The home folder is `HOME` on
macOS and Linux and `USERPROFILE` on Windows. If the same session id exists in
several project folders, it takes the newest file.

A transcript up to 4 MiB is read directly. A longer one is streamed through
`cat` (macOS, Linux) or the built-in Windows PowerShell (Windows), because a
mod can read at most 4 MiB in one go. The file is opened for shared reading,
so Claude Code keeps writing to it meanwhile.

Each entry holds:

- the time, the role (`user` or `command`) and the message id;
- the text, cut to 300 characters;
- where it was typed (for example `cli` or `app`);
- the time, id and first 300 characters of Claude's **first** text reply;
- the id of the **first** tool call Claude made in answer (used as a jump target).

It keeps your prompts, messages typed while Claude was mid-turn (stored in the
transcript as `queued_command` attachments, and not counted twice when they
reappear later as normal rows), and slash commands. Images become `[image]`.
It skips sub-agent (sidechain) rows, meta rows, compact summaries, tool
results, system reminders, local command output, task and system
notifications, messages from other Claude sessions, and "[Request interrupted"
markers.

A 15 MB transcript takes about half a second to read.

### 2. Grouping (one Haiku call)

The entries are sent to Haiku (effort low, at most 4096 output tokens, 3-minute
timeout) as a numbered list. Each line is at most 200 characters, with up to
120 characters of the reply. Times in the prompt are UTC. The list is fenced
between markers and marked as untrusted data, so instructions inside your
messages are not followed.

- **First build:** all entries are sent. Haiku is asked for 3–8 categories,
  each holding topics. A topic is a run of consecutive entries, given as
  `first` and `last` indices. Titles are at most 8 words, summaries at most 20.
- **Update:** only the new entries are sent, with the existing category names
  and the five most recent topics. Haiku is asked to reuse category names and,
  if the new entries continue the latest topic, to repeat its title.
- **Very long sessions:** the list is capped at 60,000 characters. The newest
  entries are kept. The older ones are covered by one topic called
  "Earlier work".

The answer is checked carefully:

- The first JSON object with a `categories` array is used, even inside prose
  or a code fence.
- Indices outside the range are clamped; topics left with nothing are dropped.
- **Overlaps:** a topic that starts inside the previous one is cut to start
  after it.
- **Gaps:** skipped entries join the topic before them. The first topic always
  starts at the first entry.
- Entries after the last topic stay in the New section.
- Category names that differ only in case are merged. Names are cut to 60
  characters, titles to 80, summaries to 160.
- On an update, a first topic with the same title as the latest one extends it.

If the answer cannot be used, the previous table stays as it was.

### 3. Caching

The result is saved in the plugin's own store under the key
`toc:<sessionId>`. When a session starts, a saved table is loaded straight into
the pane. No model call is needed to show it again.

### 4. Loading new talking

Two events trigger a re-read of the transcript. Neither calls the model by
itself:

- `prompt.submit` — about 1.5 seconds after you send a prompt, so the prompt
  has been saved to the file;
- `session.measure` — about 0.5 seconds after it fires. It fires at the end of
  each turn (so Claude's reply text appears), and also when a rate-limit
  reading changes.

Only one read or build runs at a time. Requests that arrive meanwhile are
merged into one more run afterwards, so a Refresh press is never lost.

**The batching rule.** After a background read, Haiku is called only when the
session already has a table **and** at least `autoGroupEvery` entries are not
yet grouped (and `autoGroupEvery` is not 0). A session that was never built is
never grouped in the background.

### 5. Rendering and width

The toggle column is 3 characters and the timestamp column is fixed at 21. The
description column takes the rest of the pane width (at least 20 characters)
and is recomputed on every redraw, so the pane follows resizing. With Wrap on,
long text runs over several lines; otherwise it is cut with an ellipsis.

### 6. Jumping

A timestamp press is handled inside the `ui.press` hook, because a host only
moves the chat in answer to your own input. The plugin asks `$.ui.scroll` to
bring the message into view. It tries several ids in turn: the row id it saw
when the chat drew that message (learned from `UserMessage` and
`AssistantMessage` renders by matching their opening text), then the
transcript's message id, then the reply and the first tool call.

**Limitation.** The Claude desktop app refuses this ("transcript not scrollable
here"). According to the plugin API, only the terminal's fullscreen layout
lets a plugin scroll the chat, and that has not yet been confirmed in live
testing. When the host refuses, the click copies the message's first 60
characters to your clipboard so you can search for them. If copying fails, a
toast shows the words instead.

## Tokens and privacy

### Token cost

**These make one Haiku call each:**

- The first `/session-toc` or **Refresh** in a session (all messages).
- A later `/session-toc` or **Refresh**, only when there are messages not yet
  grouped (only those messages are sent).
- `/session-toc rebuild` or **Rebuild** (all messages, every time).
- A background read that finds at least `autoGroupEvery` ungrouped messages, in
  a session that already has a table.

**These never call a model:**

- Sending prompts and finishing turns in a session without a table.
- Background reads that find fewer than `autoGroupEvery` new messages.
- Opening the pane when nothing is new, showing a cached table, expanding
  topics, Wrap, and clicking timestamps.
- Any read with `autoGroupEvery` set to `0`.

The first build sends at most about 60,000 characters of listing plus a short
instruction. Updates send only the new lines. The output is capped at 4096
tokens. Calls go through your normal Claude Code login and count toward your
usage like any other Haiku request.

### What is sent and stored

- **Sent:** only to Haiku, through your normal Claude Code login. A call holds
  clipped prompts and the start of Claude's replies: up to about 60,000
  characters on a first build or Rebuild, then only the new lines.
- **Stored:** the finished tables, in Claude Code's plugin store on your
  machine, for the 10 most recent sessions.
- **Nothing else:** the mod sends nothing anywhere else.

## Limitations and troubleshooting

- **Jumping does not work in the desktop app.** See "Jumping" above. Search
  the chat for the copied words instead.
- **"transcript not found for session …"** — the transcript is not under
  `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). Check that
  variable if you moved your Claude Code folder.
- **"Cannot read the transcript (N MB): …"** — the transcript is over 4 MiB
  and the tool that streams it could not run: `cat` on macOS and Linux,
  `powershell` (or `pwsh`, or `cat`) on Windows. Check that one of them is on
  the `PATH` Claude Code runs with.
- **"PowerShell could not be started."** — you are running version 0.1.0,
  which needed PowerShell 7 on macOS and Linux. Update the mod to 0.2.0 or
  later.
- **"Claude could not group the topics."** — the first grouping failed or
  gave no usable answer. Press Refresh to try again. When a background update
  fails, the message says so and the new messages stay in the New section; the
  next background try waits until `autoGroupEvery` more messages arrive, so a
  failing call is never repeated on every message.
- **Very long sessions:** the oldest entries may be folded into "Earlier work",
  and a session with very many topics may not fit in the 4096-token answer.
  Rebuild, or accept the fold.
- **Only the start of each reply** is shown and used: Claude's first text
  block, cut to 300 characters.
- The table belongs to one session id. A new session (for example after
  `/clear`) starts with an empty table.
- Saved tables are kept for the 10 most recent sessions; older ones are
  deleted. They live in the plugin's store, which Claude Code limits to 4 MiB
  in all. If the store refuses a write, the pane keeps working; the table is
  just not saved for the next start.
- Background reads run only in a session whose table you have opened (or that
  has a saved table). Each takes well under a second of CPU and no tokens.
- On a surface without buttons, the buttons show as dim `[Refresh]`-style text.
  Use the `/session-toc` command there.

## Development

Files:

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Manifest and the two options. |
| `hooks/hooks.json` | Lists the hooks module. |
| `hooks/register.tsx` | Command, pane, background loading, jumping. |
| `hooks/group.ts` | Prompts, answer parsing and merging. |
| `hooks/extract.ts` | Transcript reader: finds the file, reads or streams it, turns it into entries. |
| `types/index.d.ts` | The plugin's state and data types. |
| `tests/*.test.ts` | Tests for the transcript reader, grouping and the pane. |

Run these from the repository root. Check the manifest, run the tests, and
type-check:

```sh
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p . --noEmit
```

`tsconfig.json` extends `./.claude-plugin/types/tsconfig.json`. Claude Code
writes that folder (its API declarations for your build) into the plugin
whenever it loads it, so load the plugin once, for example with
`--plugin-dir`, before type-checking. `.claude-plugin/types/` is in
`.gitignore`.

While a session loads the folder through `--plugin-dir` or
`CLAUDE_CODE_PLUGIN_DIRS`, saving a file reloads the mod straight away.

`hooks/extract.ts` keeps everything that touches the engine behind a small
`TranscriptIO` object, which `register.tsx` builds from `$`. The tests in
`tests/extract.test.ts` pass a fake one, so the reader is tested without real
files.

## See also

- [claude-code-usage-meter](https://github.com/ewxgwy1987/claude-code-usage-meter)
  — a band above the prompt with plan rate limits, context fill and session
  cost.
- [claude-code-progress-board](https://github.com/ewxgwy1987/claude-code-progress-board)
  — a pane with bars and time-left estimates for tasks, subagents and
  workflow runs.
- [claude-code-mods](https://github.com/ewxgwy1987/claude-code-mods) — the
  collection, for installing all three at once.

## License

[MIT](LICENSE) © 2026 Rain Guo
