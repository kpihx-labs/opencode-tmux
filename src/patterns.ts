export const PANE_SUBS_OPTION = "@collab_subs"
export const PANE_ACTOR_OPTION = "@collab_actor"
export const PANE_STATE_OPTION = "@state"
export const PANE_AGENT_OPTION = "@opencode_agent"

export const KNOWN_IDLE_SHELLS = ["zsh", "bash", "sh", "fish"] as const

export type PaneSubscriber = {
  sessionID: string
  timeoutS: number
}

export type WriteGateResult =
  | { allowed: true; mode: "free" | "idle" | "agent_shared" }
  | { allowed: false; reason: string }

/**
 * Parse `@collab_subs` option (`ses_a:30,ses_b:0`).
 * Each entry carries that subscriber's own watchdog timeout in seconds (0 = real transitions only).
 */
export function parsePaneSubs(raw: string | undefined | null): PaneSubscriber[] {
  if (typeof raw !== "string" || raw.trim() === "") return []
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sessionID, timeout] = entry.split(":")
      const timeoutS = Number.parseInt(timeout ?? "0", 10)
      return {
        sessionID: (sessionID ?? "").trim(),
        timeoutS: Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 0,
      }
    })
    .filter((entry) => entry.sessionID.length > 0)
}

export function formatPaneSubs(members: readonly PaneSubscriber[]): string {
  return members
    .filter((member) => member && typeof member.sessionID === "string" && member.sessionID.trim().length > 0)
    .map((member) => `${member.sessionID.trim()}:${member.timeoutS > 0 ? Math.floor(member.timeoutS) : 0}`)
    .join(",")
}

/**
 * Preserve an incomplete final log line until its terminating newline arrives,
 * preventing torn reads when the shell appends concurrently.
 */
export function splitCompleteLogLines(remainder: string, chunk: string): { completeLines: string[]; remainder: string } {
  const lines = `${remainder}${chunk}`.split("\n")
  return {
    completeLines: lines.slice(0, -1),
    remainder: lines.at(-1) ?? "",
  }
}

export function isIdleShell(command: string): boolean {
  const trimmed = command.trim()
  return trimmed === "" || (KNOWN_IDLE_SHELLS as readonly string[]).includes(trimmed)
}

/**
 * Four-step AUTO/FREE write gate (`k-tmux/references/pane-lock.md`):
 *   1. `@state = 1` (operator forced FREE via Ctrl-a L) -> allow
 *   2. pane IDLE (`zsh`/`bash`/`sh`/`fish`)             -> allow
 *   3. `@opencode_agent = 1` (launched by an agent)     -> allow (shared)
 *   4. otherwise                                        -> block loudly
 */
export function evaluateWriteGate(input: {
  paneId: string
  forcedFree: boolean
  currentCommand: string
  agentMarked: boolean
  idleTargets?: string[]
}): WriteGateResult {
  if (input.forcedFree) return { allowed: true, mode: "free" }
  if (isIdleShell(input.currentCommand)) return { allowed: true, mode: "idle" }
  if (input.agentMarked) return { allowed: true, mode: "agent_shared" }

  const idleHint =
    input.idleTargets && input.idleTargets.length > 0
      ? `Idle panes available now: ${input.idleTargets.join(", ")}.`
      : "No idle panes found — create a temporary split with tmux_pane({ action: \"split\" })."

  return {
    allowed: false,
    reason:
      `BLOCKED: pane ${input.paneId} is occupied by a non-opencode-agent command: '${input.currentCommand}' ` +
      `(not one of ${KNOWN_IDLE_SHELLS.join("/")}). This pane is locked (AUTO): it belongs to the operator ` +
      `or to a command no OpenCode agent launched, so no agent may write into it.\n` +
      `Do NOT retry, do NOT poll it. Options:\n` +
      `  - ${idleHint}\n` +
      `  - If you must work IN THIS pane, ask KπX in chat to press Ctrl-a L in ${input.paneId} (switches it to FREE), then resume.`,
  }
}

const BARE_CONFIRM_KEY = /^(?:y|yes|o|oui)$/i
const CURL_INLINE_SECRET_HEADER = /\bcurls?\b[^\n]*-H\s+["'][^"']*\$[A-Za-z_][A-Za-z0-9_]*/i
const ENV_FILE_CAT_OR_SOURCE = /(?:^|\s|;|&|\|)(?:cat|head|tail|less|more|bat|source|\.)\s+[^\s;|&]*\.env(?:\.(?!example\b)[a-z0-9_-]+)?(?:\s|$|;|&|\|)/i

/**
 * Enforce security & HITL invariants on `tmux_send` payloads:
 * - Never pre-inject bare HITL confirmation keys ('y'/'yes'/'oui') via keys/command.
 *   (Inside a pipeline like `printf "y\n" | with-env curls ...` is allowed when authorized.)
 * - Never expand secret variables in curl `-H` headers or read `.env` files.
 */
export function validateSendPayload(input: { command?: string; keys?: string[] }): void {
  if (input.command) {
    const trimmed = input.command.trim()
    if (BARE_CONFIRM_KEY.test(trimmed)) {
      throw new Error(
        "🔒 Auto-injection of HITL confirmation ('y'/'yes'/'oui') is blocked. " +
        "Let KπX confirm interactively in the pane (or with explicit unattended authorization, pipe `printf \"y\\n\" | ...` inside the full command).",
      )
    }
    if (CURL_INLINE_SECRET_HEADER.test(trimmed)) {
      throw new Error(
        "🔒 Secret variable expansion in curl `-H` header is blocked. " +
        "Use `with-env curls -p <provider> ...` instead so the secret never reaches the command line.",
      )
    }
    if (ENV_FILE_CAT_OR_SOURCE.test(trimmed)) {
      throw new Error(
        "🔒 Direct reading or sourcing of `.env` files is blocked (secrets zero-touch).",
      )
    }
  }
  if (input.keys && input.keys.length > 0) {
    const joined = input.keys.filter((k) => k !== "Enter" && k !== "C-m").join("").trim()
    if (BARE_CONFIRM_KEY.test(joined)) {
      throw new Error(
        "🔒 Auto-injection of HITL confirmation keys ('y'/'yes'/'oui') is blocked.",
      )
    }
  }
}
