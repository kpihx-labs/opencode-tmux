# Contract

## Scope

`opencode-tmux` is the dedicated tmux orchestration & notification plugin for
OpenCode. It owns external tmux panes (`pane:%N`) cleanly and independently of
`opencode-collab` (which owns `session:ses_...`).

## Two orthogonal axes on a pane

| Axis | Question | Authoritative Store |
| --- | --- | --- |
| **Write** (lock) | May an agent type into this pane? | `@state` (operator `Ctrl-a L`), `@opencode_agent` |
| **Notify** (bus) | Who receives events for this pane? | `@collab_subs` (`ses_a:30,ses_b:0`), `@collab_actor` |

Authoritative pane options live **in tmux** (zero IPC, visible in the tmux
border `FREE`/`AUTO`/`AGENT`/`🤝`, self-cleans on reboot).

## Write gate (`AUTO` / `FREE`)

Evaluated by `tmux_send` in exact order:
1. `@state = 1` (operator forced `FREE` via `Ctrl-a L`) → **ALLOW**
2. Pane idle (`pane_current_command` ∈ `zsh`/`bash`/`sh`/`fish`) → **ALLOW**
3. `@opencode_agent = 1` (command launched by an OpenCode agent) → **ALLOW** (shared)
4. Otherwise (operator-occupied pane) → **BLOCK** with idle pane alternatives and `Ctrl-a L` hint

## Delivery & multi-instance guarantees

- **Shell-return truth:** `.kshrc` `precmd`/`PROMPT_COMMAND` appends JSON lines
  `{"event":"prompt","pane":"%N","ts":...}` to `/tmp/tmux-pane-done.log`.
- **Cross-instance deduplication:** `TmuxRegistry.claimEvent()` uses SQLite CAS
  (`dedup_claims`) so N OpenCode location instances emit **1** notification per
  event, never N.
- **Per-subscriber patience:** each subscriber owns its own `timeout_s` in
  `@collab_subs` and adjusts it via `tmux_adjust` (no `: TMUX_ADJUST` shell hack).
- **Non-blocking:** deliveries use `promptAsync` / `ctx.session.synthetic` and
  persist in `pending_notify` until acknowledged.
- **Kill safety:** `tmux_pane({ action: "kill" })` refuses to kill any pane not
  recorded in `owned_panes` (created by an agent via `tmux_pane`).
