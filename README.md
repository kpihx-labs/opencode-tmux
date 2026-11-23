# opencode-tmux

First-class OpenCode plugin & tools for tmux pane orchestration, `AUTO`/`FREE`
write locks (`Ctrl-a L`), multi-subscriber watches, and event-driven
shell-return notifications.

Replaces the legacy single-file `tmux-notify.js` hook/regex bridge (`TMUX_TIMEOUT=... tmux send-keys`, `: TMUX_ADJUST`) and decouples tmux completely from `opencode-collab`.

## Tools

| Tool | Purpose |
| --- | --- |
| `tmux_list` | List sessions/windows/panes with live command, `FREE`/`AUTO`/`LOCKED` status, and `@collab_subs`. |
| `tmux_send` | Safely send a command or keys (`-l` literal + `Enter`), enforcing `AUTO`/`FREE`, secret/HITL guards, and arming notifications. |
| `tmux_attach` | Subscribe read-only to a pane (`timeout_s: 0` for transitions only, `>0` for periodic watchdog). |
| `tmux_detach` | Unsubscribe from a pane without disturbing other subscribers. |
| `tmux_adjust` | Adjust your own watchdog `timeout_s` on a pane without touching the pane. |
| `tmux_read` | Bounded `capture-pane` diagnostic read (never blocked). |
| `tmux_pane` | Safe `split`, `new_window`, `new_session`, `rename`, and `kill` (restricted to agent-created temp panes). |

## Notifications

- `<tmux-armed>` / `<tmux-control>` / `<tmux-shared>` on `tmux_send`
- `<tmux-notify>` when the pane returns to its shell prompt (or closes)
- `<tmux-watchdog>` every `timeout_s` seconds while busy (A/B/C/D decision tree)
- `<tmux-input>` when another OpenCode session writes to a pane you watch

## Development

```sh
bun install
make check
make push   # pushes gitlab first, then github
```
