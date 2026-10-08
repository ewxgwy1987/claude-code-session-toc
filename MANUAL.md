# session-toc user manual

This manual covers everyday use of session-toc. The [README](README.md) is the
full reference, including install options and how the mod works inside.

session-toc adds a **Contents** pane: a table of contents of the whole current
session. Topics are grouped into categories, and each one has a timestamp.

## 1. Get started

1. **Check PowerShell.** Windows already has it. On macOS and Linux, install
   PowerShell 7 so that `pwsh` is on your `PATH`.
2. **Install** the mod as the [README](README.md#install) describes. The
   quickest way is `claude --plugin-dir /path/to/claude-code-session-toc`.
3. **Talk for a while**, then type `/session-toc`. The **Contents** pane opens
   and builds a table of the session so far. This takes one Haiku call.
4. **Keep talking.** New messages appear at the top of the pane by themselves.
   Every 5 new messages, they are filed into topics.

## 2. Where the pane appears

| Surface | Where |
|---|---|
| Terminal | Docked beside the chat in the fullscreen layout from 110 columns; otherwise above the prompt |
| Desktop app | A side panel. If other mods add panes too, each one is a tab |
| Phone (Remote Control) | Where the app places panes |

On a surface without buttons, the buttons show as dim `[Refresh]`-style text.
Use the commands there instead.

## 3. Commands

| Command | What it does |
|---|---|
| `/session-toc` | Opens the pane and adds any new messages. One small Haiku call, only if something is new |
| `/session-toc rebuild` | Regroups the whole session from scratch (one Haiku call) |
| `/session-toc wrap` | Switches between wrapped and single-line text |
| `/session-toc wrap on` / `wrap off` | Turns wrapping on or off for this session |

The command runs at once, even while Claude is busy.

## 4. Options

Change these in Claude Code's config menu (`/config`), where plugin options are
listed under the plugin's name. Changing an option reloads the plugin.

| Option | Default | Meaning |
|---|---|---|
| `wrapText` | off | Wrap long titles, summaries and messages by default. The Wrap button and `/session-toc wrap` override it for the current session |
| `autoGroupEvery` | 5 | Group new messages into topics once this many are waiting. `0` means only when you press Refresh or run `/session-toc` |

## 5. Reading the pane

```
Session contents · 9 topics · 3 categories · 41 messages since 2026-06-01 09:05:12
[Refresh] [Rebuild] [Wrap]

New · 2 not grouped yet (grouped at 5, or press Refresh)
   2026-06-01 15:42:10  You: Add a dark theme to the settings page
   2026-06-01 15:30:02  Command: /compact

Backend
▸  2026-06-01 09:05:12  Database migration script
                        Wrote and tested a migration that adds the orders table
```

- **Categories** are the coloured headings, such as *Backend* above.
- **Topics** sit under each category. A topic has the time it started, a bold
  title and a dim one-line summary.
- **▸ / ▾** opens or closes a topic. Only one topic is open at a time. An open
  topic lists its messages, each with its own timestamp:
  - `You: …` is a prompt you typed, including ones typed while Claude was busy.
  - `Command: …` is a slash command and its arguments.
  - `Claude: …` (dim) is the start of Claude's first text reply.
- **New · N not grouped yet** (yellow, at the top) lists messages read since
  the last grouping, newest first. Showing them costs nothing. Once
  `autoGroupEvery` are waiting, one Haiku call files them into topics.
- **Times** are `YYYY-MM-dd HH:mm:ss`, in your local time zone.

### Buttons

| Button | What it does |
|---|---|
| **Refresh** | Reads the transcript again and groups only what is new. No call if nothing is new |
| **Rebuild** | Regroups every message from scratch. Use it when the categories no longer fit |
| **Wrap / Single line** | Shows long text in full over several lines, or cuts it to one line |

### Width

The description column fills whatever width the pane has. Widen the pane to
see more text. It follows resizing as you go.

### Clicking a timestamp

- **Terminal, fullscreen layout:** the click asks Claude Code to scroll the
  chat to that message. This has not been confirmed in live testing yet; if
  it doesn't scroll, you get the same copy fallback as the desktop app.
- **Desktop app:** the app does not let mods scroll its chat. The click copies
  the message's opening words (about 60 characters) to your clipboard instead,
  so you can search the chat for them. If copying fails, a toast shows the
  words.

### Saved tables

The table is saved when it is built. When you resume the session, it comes
back by itself, with no model call. A new session, for example after `/clear`,
starts with an empty table.

## 6. Cost in tokens

| Action | Model calls |
|---|---|
| First `/session-toc` or Refresh in a session | One Haiku call with all messages |
| Rebuild | One Haiku call with all messages, every time |
| Later Refresh, or automatic grouping | One small Haiku call with only the new messages |
| Reading new messages as you talk | None |
| Opening the pane when nothing is new, expanding topics, Wrap, clicking timestamps | None |
| Any session where you never opened the pane | None |

Calls go through your normal Claude Code login and count toward your usage.
A first build sends at most about 60,000 characters of clipped prompts and
replies. Tables are kept on your machine for the 10 most recent sessions.
Nothing is sent anywhere else.

## 7. Troubleshooting

| Symptom | What to do |
|---|---|
| `/session-toc` is unknown | The mod did not load. Run `claude plugin validate .` in the clone. For `CLAUDE_CODE_PLUGIN_DIRS`, use an absolute path, put it in **user** settings, and start a new session |
| "PowerShell could not be started." | Install PowerShell 7 (`pwsh`) and put it on your `PATH` |
| "transcript not found for session …" | The transcript is not under `~/.claude/projects`. If you moved your Claude Code folder, check `CLAUDE_CONFIG_DIR` |
| "The extractor output was not valid JSON." | Run `scripts/extract.ps1` by hand to see the error (see the README's Development section) |
| "Claude could not group the topics." | Press Refresh. Automatic grouping waits for more messages before trying again, so a failing call is not repeated on every message |
| A timestamp click copies text instead of jumping | Expected in the desktop app. Search the chat for the copied words |
| Old work shows as "Earlier work" | The session is very long, so the oldest messages were folded into one topic. Rebuild, or accept the fold |
| The desktop app shows the pane twice | Two folders load the same mod, for example an old copy plus `CLAUDE_CODE_PLUGIN_DIRS`. Keep one |

## See also

[claude-code-mods](https://github.com/ewxgwy1987/claude-code-mods) lists this
mod with its two siblings, usage-meter and progress-board.
