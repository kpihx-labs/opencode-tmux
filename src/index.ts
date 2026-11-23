import * as fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import {
  evaluateWriteGate,
  formatPaneSubs,
  isIdleShell,
  PANE_ACTOR_OPTION,
  PANE_AGENT_OPTION,
  PANE_STATE_OPTION,
  PANE_SUBS_OPTION,
  type PaneSubscriber,
  parsePaneSubs,
  splitCompleteLogLines,
  validateSendPayload,
} from "./patterns.js"
import { TmuxRegistry } from "./registry.js"
import { ExecTmuxDriver, type PaneInfo, type TmuxDriver } from "./tmux.js"

export {
  evaluateWriteGate,
  formatPaneSubs,
  isIdleShell,
  PANE_ACTOR_OPTION,
  PANE_AGENT_OPTION,
  PANE_STATE_OPTION,
  PANE_SUBS_OPTION,
  type PaneSubscriber,
  parsePaneSubs,
  splitCompleteLogLines,
  validateSendPayload,
} from "./patterns.js"
export { TmuxRegistry } from "./registry.js"
export { ExecTmuxDriver, type PaneInfo, type TmuxDriver } from "./tmux.js"

type Options = {
  databasePath?: string
  notifyLogPath?: string
  reconcileMs?: number
  logPollMs?: number
  driver?: TmuxDriver
}

type LocalEntry = {
  subs: Map<string, { timeoutS: number; nextAt: number; count: number }>
  timer: ReturnType<typeof setTimeout> | null
}

function describeSubscribers(subs: readonly string[], self?: string): string {
  const others = subs.filter((id) => id !== self)
  if (others.length === 0) return "only you are subscribed"
  const mine = self ? "you, " : ""
  return `${mine}${others.join(", ")}`
}

function lockLabel(pane: PaneInfo): "FREE" | "AUTO_IDLE" | "AUTO_AGENT" | "LOCKED" {
  if (pane.forcedFree) return "FREE"
  if (pane.idle) return "AUTO_IDLE"
  if (pane.agentMarked) return "AUTO_AGENT"
  return "LOCKED"
}

export function notificationFor(input: {
  paneId: string
  lines: string
  kind: "complete" | "watchdog" | "foreign-input" | "gone"
  actor?: string
  subscribers: string[]
  self: string
  timeoutS?: number
  count?: number
}): string {
  const { paneId, lines, kind, actor, subscribers, self } = input
  const lineCount = lines === "" ? 0 : lines.split("\n").length
  const body = `Last ${lineCount} output line${lineCount === 1 ? "" : "s"}:\n===\n${lines}\n===\n`
  const audience = describeSubscribers(subscribers, self)
  const actorLine = actor
    ? `Launched by: ${actor}\n`
    : "Launched by: the operator or a non-OpenCode process (no agent claimed this pane)\n"

  if (kind === "gone") {
    return (
      `<tmux-notify>\n` +
      `Pane ${paneId} no longer exists on the tmux server (closed or exited).\n` +
      `Subscribers released: ${audience}.\n` +
      `</tmux-notify>`
    )
  }

  if (kind === "foreign-input") {
    return (
      `<tmux-input>\n` +
      `Pane ${paneId} received input from ANOTHER OpenCode session${actor ? ` (${actor})` : ""}.\n` +
      `Subscribers: ${audience}.\n` +
      body +
      `What this means: the pane is shared on purpose — several agents may cooperate on it. ` +
      `Your subscription is UNCHANGED and your timeout is untouched.\n` +
      `Nothing is required of you. If the input changes what you expected, call \`tmux_read({ target: "${paneId}" })\` once, then continue. Never poll.\n` +
      `</tmux-input>`
    )
  }

  if (kind === "complete") {
    return (
      `<tmux-notify>\n` +
      `Pane ${paneId}: the command has FINISHED (shell prompt returned).\n` +
      actorLine +
      `Subscribers: ${audience}.\n` +
      body +
      `This is the definitive result for this pane. Use it and continue your task — nothing else to do here.\n` +
      `</tmux-notify>`
    )
  }

  const timeoutS = input.timeoutS ?? 30
  const check = input.count ?? 1
  const heavy = check >= 3
  const elapsed = check * timeoutS

  return (
    `<tmux-watchdog>\n` +
    `STATUS: the command in pane ${paneId} has NOT returned to its shell yet ` +
    `(your check #${check}, ~${elapsed}s elapsed since you subscribed or last adjusted).\n` +
    actorLine +
    `Subscribers: ${audience}. Each subscriber has its OWN timeout — this message concerns only yours (${timeoutS}s).\n` +
    body +
    `This is NOT a final result. You will keep receiving it about every ${timeoutS}s until EITHER the pane ` +
    `returns to its shell on its own (final <tmux-notify>) OR you interrupt it (option D). Decide now:\n` +
    `  A. INTERACTIVE program you are driving -> send input via \`tmux_send({ target: "${paneId}", ... })\`, or abort with \`keys: ["C-c"]\`.\n` +
    `  B. Working NORMALLY but MUCH slower than ${timeoutS}s -> call \`tmux_adjust({ target: "${paneId}", timeout_s: <bigger_seconds> })\`.\n` +
    `  C. Working normally and this interval is fine -> do nothing: continue other work in parallel.\n` +
    `  D. STUCK, crashed, or no longer needed -> call \`tmux_send({ target: "${paneId}", keys: ["C-c"] })\` now.\n` +
    (heavy ? `NOTE: check #${check} (~${elapsed}s total) reads as a genuinely long process. Consider B or D now.\n` : "") +
    `Never sleep or poll this pane manually — one of A/B/C/D is always the right move.\n` +
    `</tmux-watchdog>`
  )
}

export function opencodeTmux(overrides: Options = {}): Plugin {
  return async (input, pluginOptions) => {
    const opts = (pluginOptions ?? {}) as Record<string, unknown>
    const databasePath =
      overrides.databasePath ??
      (typeof opts.databasePath === "string" && opts.databasePath.length > 0 ? opts.databasePath : undefined) ??
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode-tmux", "state.sqlite")
    const notifyLogPath =
      overrides.notifyLogPath ??
      (typeof opts.notifyLogPath === "string" && opts.notifyLogPath.length > 0 ? opts.notifyLogPath : undefined) ??
      process.env.TMUX_NOTIFY_LOG ??
      "/tmp/tmux-pane-done.log"
    const reconcileMs =
      overrides.reconcileMs ??
      (typeof opts.reconcileMs === "number" && opts.reconcileMs >= 250 ? opts.reconcileMs : 5_000)
    const logPollMs =
      overrides.logPollMs ??
      (typeof opts.logPollMs === "number" && opts.logPollMs >= 50 ? opts.logPollMs : 400)

    const driver = overrides.driver ?? new ExecTmuxDriver()
    const registry = new TmuxRegistry(databasePath)
    const localTimers = new Map<string, LocalEntry>()
    const shutdown = new AbortController()
    const flushing = new Set<string>()
    const client = input.client as unknown as {
      session: {
        promptAsync?: (req: unknown) => Promise<unknown>
        prompt?: (req: unknown) => Promise<unknown>
      }
    }

    function dropEntry(paneId: string) {
      const entry = localTimers.get(paneId)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      localTimers.delete(paneId)
    }

    function schedule(paneId: string) {
      if (shutdown.signal.aborted) return
      const entry = localTimers.get(paneId)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      const deadlines = Array.from(entry.subs.values())
        .filter((s) => s.nextAt > 0)
        .map((s) => s.nextAt)
      if (deadlines.length === 0) return
      const wait = Math.max(100, Math.min(...deadlines) - Date.now())
      entry.timer = setTimeout(() => {
        void fireWatchdogs(paneId)
      }, wait)
      entry.timer.unref?.()
    }

    function syncEntry(paneId: string, now = Date.now()): LocalEntry | null {
      const members = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
      if (members.length === 0) {
        dropEntry(paneId)
        return null
      }
      let entry = localTimers.get(paneId)
      if (!entry) {
        entry = { subs: new Map(), timer: null }
        localTimers.set(paneId, entry)
      }
      const seen = new Set<string>()
      for (const member of members) {
        seen.add(member.sessionID)
        const current = entry.subs.get(member.sessionID)
        if (!current) {
          entry.subs.set(member.sessionID, {
            timeoutS: member.timeoutS,
            nextAt: member.timeoutS > 0 ? now + member.timeoutS * 1000 : 0,
            count: 0,
          })
        } else if (current.timeoutS !== member.timeoutS) {
          current.timeoutS = member.timeoutS
          current.count = 0
          current.nextAt = member.timeoutS > 0 ? now + member.timeoutS * 1000 : 0
        }
      }
      for (const sid of Array.from(entry.subs.keys())) {
        if (!seen.has(sid)) entry.subs.delete(sid)
      }
      if (entry.subs.size === 0) {
        dropEntry(paneId)
        return null
      }
      schedule(paneId)
      return entry
    }

    function subscribePane(paneId: string, sessionID: string, timeoutS: number, forceTimeout: boolean): { members: PaneSubscriber[]; existed: boolean; resolvedTimeout: number } {
      const members = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
      const previous = members.find((m) => m.sessionID === sessionID)
      const resolvedTimeout = forceTimeout ? timeoutS : (previous ? previous.timeoutS : timeoutS)
      const next: PaneSubscriber[] = previous
        ? members.map((m) => (m.sessionID === sessionID ? { sessionID, timeoutS: resolvedTimeout } : m))
        : [...members, { sessionID, timeoutS: resolvedTimeout }]
      if (!driver.setPaneOption(paneId, PANE_SUBS_OPTION, formatPaneSubs(next))) {
        throw new Error(`tmux refused to write ${PANE_SUBS_OPTION} on pane ${paneId}`)
      }
      return { members: next, existed: Boolean(previous), resolvedTimeout }
    }

    async function deliverRaw(sessionID: string, text: string) {
      const body = { parts: [{ type: "text", text, synthetic: true }] }
      if (typeof client.session.promptAsync === "function") {
        await client.session.promptAsync({ path: { id: sessionID }, body })
      } else if (typeof client.session.prompt === "function") {
        await client.session.prompt({ path: { id: sessionID }, body })
      } else {
        throw new Error("OpenCode client exposes neither promptAsync nor prompt")
      }
    }

    async function flushSession(sessionID: string) {
      if (!sessionID || flushing.has(sessionID) || shutdown.signal.aborted) return
      flushing.add(sessionID)
      try {
        const batch = registry.claimPendingNotices(sessionID)
        if (batch.length === 0) return
        const text = batch.map((n) => n.text).join("\n\n")
        try {
          await deliverRaw(sessionID, text)
          registry.markDelivered(batch.map((n) => n.id))
        } catch {
          registry.releaseClaims(batch.map((n) => n.id))
        }
      } finally {
        flushing.delete(sessionID)
      }
    }

    async function fireWatchdogs(paneId: string) {
      if (shutdown.signal.aborted) return
      const entry = localTimers.get(paneId)
      if (!entry) return
      const members = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
      if (members.length === 0) {
        dropEntry(paneId)
        return
      }
      const now = Date.now()
      const meta = registry.getPaneMeta(paneId)
      const maxLines = meta?.maxLines ?? 50
      const sliced = driver.capturePane(paneId, maxLines)
      const actor = meta?.writerSessionID || driver.paneOption(paneId, PANE_ACTOR_OPTION) || ""
      const subscribers = members.map((m) => m.sessionID)

      for (const [sessionID, sub] of Array.from(entry.subs.entries())) {
        if (sub.timeoutS <= 0 || sub.nextAt === 0 || sub.nextAt > now) continue
        const bucket = Math.floor(sub.nextAt / (sub.timeoutS * 1000))
        sub.count += 1
        sub.nextAt = now + sub.timeoutS * 1000
        if (!registry.claimEvent(`watchdog:${paneId}:${sessionID}:${bucket}`)) continue
        registry.notify(
          sessionID,
          paneId,
          notificationFor({
            paneId,
            lines: sliced,
            kind: "watchdog",
            actor,
            subscribers,
            self: sessionID,
            timeoutS: sub.timeoutS,
            count: sub.count,
          }),
        )
        void flushSession(sessionID)
      }
      if (localTimers.has(paneId)) schedule(paneId)
    }

    async function completePane(paneId: string, kind: "complete" | "gone" = "complete") {
      const members = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
      const entry = localTimers.get(paneId)
      const subscribers = members.length > 0 ? members.map((m) => m.sessionID) : Array.from(entry?.subs.keys() ?? [])
      if (subscribers.length === 0) {
        dropEntry(paneId)
        return
      }
      const meta = registry.getPaneMeta(paneId)
      const maxLines = meta?.maxLines ?? 50
      const sliced = kind === "complete" ? driver.capturePane(paneId, maxLines) : ""
      const actor = meta?.writerSessionID || driver.paneOption(paneId, PANE_ACTOR_OPTION) || ""

      // Release shared pane state BEFORE delivering so a slow transport can
      // never make the next writer believe the pane is still armed.
      if (kind === "complete") {
        driver.unsetPaneOption(paneId, PANE_SUBS_OPTION)
        driver.unsetPaneOption(paneId, PANE_ACTOR_OPTION)
      }
      registry.deletePaneMeta(paneId)
      dropEntry(paneId)

      for (const sessionID of subscribers) {
        registry.notify(
          sessionID,
          paneId,
          notificationFor({
            paneId,
            lines: sliced,
            kind,
            actor,
            subscribers,
            self: sessionID,
          }),
        )
      }
      await Promise.all(subscribers.map((sid) => flushSession(sid)))
    }

    const readyTimeoutMs = overrides.driver ? 0 : 1500

    function parseEventTsNs(ts: unknown): bigint {
      if (typeof ts === "bigint") return ts
      if (typeof ts === "number" && Number.isFinite(ts)) {
        // Handle ms vs ns timestamps if a caller supplies ms in tests
        return ts < 1e14 ? BigInt(Math.floor(ts)) * 1_000_000n : BigInt(Math.floor(ts))
      }
      if (typeof ts === "string" && /^\d+$/.test(ts.trim())) {
        const val = BigInt(ts.trim())
        return val < 100_000_000_000_000n ? val * 1_000_000n : val
      }
      return 0n
    }

    async function waitForPaneReady(paneId: string, afterNs: bigint): Promise<boolean> {
      if (readyTimeoutMs <= 0) return true
      const deadline = Date.now() + readyTimeoutMs
      let baselineOffset = 0
      try { baselineOffset = Math.max(0, fs.statSync(notifyLogPath).size - 8192) } catch {}
      while (Date.now() < deadline && !shutdown.signal.aborted) {
        try {
          const stat = fs.statSync(notifyLogPath)
          if (stat.size > baselineOffset) {
            const buf = Buffer.alloc(stat.size - baselineOffset)
            const fd = fs.openSync(notifyLogPath, "r")
            fs.readSync(fd, buf, 0, buf.length, baselineOffset)
            fs.closeSync(fd)
            const lines = buf.toString("utf8").split("\n")
            for (const line of lines) {
              if (!line.includes(paneId)) continue
              try {
                const ev = JSON.parse(line) as { event?: string; pane?: string; ts?: unknown }
                if (ev.event === "prompt" && ev.pane === paneId && parseEventTsNs(ev.ts) >= afterNs) {
                  return true
                }
              } catch {}
            }
          }
        } catch {}
        await Bun.sleep(40)
      }
      return false
    }

    function processPromptLogLine(line: string) {
      const trimmed = line.trim()
      if (!trimmed) return
      let event: { event?: string; pane?: string; ts?: number | string }
      try {
        event = JSON.parse(trimmed)
      } catch {
        return
      }
      if (event.event !== "prompt" || typeof event.pane !== "string" || !event.pane.startsWith("%")) return
      const eventTsNs = parseEventTsNs(event.ts)
      const meta = registry.getPaneMeta(event.pane)
      if (meta && meta.armedAtNs > 0n && eventTsNs > 0n && eventTsNs <= meta.armedAtNs) return

      const cmdNow = driver.paneCurrentCommand(event.pane)
      // Stale prompt events must never clear a genuinely running command.
      if (cmdNow && !isIdleShell(cmdNow)) return

      const dedupKey = `prompt:${event.pane}:${String(event.ts ?? "0")}`
      if (!registry.claimEvent(dedupKey)) return

      driver.unsetPaneOption(event.pane, PANE_AGENT_OPTION)
      const members = parsePaneSubs(driver.paneOption(event.pane, PANE_SUBS_OPTION))
      if (members.length > 0 || localTimers.has(event.pane)) {
        void completePane(event.pane, "complete")
      }
    }

    function startWatcher() {
      let lastOffset = 0
      try {
        lastOffset = fs.statSync(notifyLogPath).size
      } catch {}
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let remainder = ""

      function poll() {
        if (stopped || shutdown.signal.aborted) return
        let size = 0
        try {
          size = fs.statSync(notifyLogPath).size
        } catch {
          timer = setTimeout(poll, logPollMs)
          timer.unref?.()
          return
        }
        if (size < lastOffset) {
          lastOffset = 0
          remainder = ""
        }
        if (size !== lastOffset) {
          let data: string | null = null
          try {
            const buf = Buffer.alloc(size - lastOffset)
            const fd = fs.openSync(notifyLogPath, "r")
            fs.readSync(fd, buf, 0, buf.length, lastOffset)
            fs.closeSync(fd)
            data = buf.toString("utf8")
          } catch {}
          if (data !== null) {
            lastOffset = size
            const parsed = splitCompleteLogLines(remainder, data)
            remainder = parsed.remainder
            for (const line of parsed.completeLines) processPromptLogLine(line)
          }
        }
        timer = setTimeout(poll, logPollMs)
        timer.unref?.()
      }

      timer = setTimeout(poll, logPollMs)
      timer.unref?.()
      return { stop() { stopped = true; if (timer) clearTimeout(timer) } }
    }

    function startReconciler() {
      let stopped = false
      let timer: ReturnType<typeof setTimeout> | null = null

      function tick() {
        if (stopped || shutdown.signal.aborted) return
        try {
          const panes = driver.listPanes()
          const existingIds = new Set(panes.map((p) => p.paneId))
          const liveSubscribed = new Set<string>()
          for (const pane of panes) {
            if (pane.subscribers.length > 0) {
              liveSubscribed.add(pane.paneId)
              syncEntry(pane.paneId)
            }
          }
          for (const paneId of Array.from(localTimers.keys())) {
            if (!existingIds.has(paneId)) {
              if (registry.claimEvent(`gone:${paneId}:${Math.floor(Date.now() / 10_000)}`)) {
                void completePane(paneId, "gone")
              } else {
                dropEntry(paneId)
              }
            } else if (!liveSubscribed.has(paneId)) {
              dropEntry(paneId)
            }
          }
          for (const sid of registry.sessionsWithNotices()) void flushSession(sid)
        } catch {}
        timer = setTimeout(tick, reconcileMs)
        timer.unref?.()
      }

      timer = setTimeout(tick, reconcileMs)
      timer.unref?.()
      return { stop() { stopped = true; if (timer) clearTimeout(timer) } }
    }

    try { fs.closeSync(fs.openSync(notifyLogPath, "a+")) } catch {}
    const watcher = startWatcher()
    const reconciler = startReconciler()

    function resolveTargetOrThrow(target: string): string {
      const paneId = driver.resolvePane(target)
      if (!paneId) {
        const panes = driver.listPanes()
        const sample = panes.slice(0, 8).map((p) => `${p.paneId} (${p.target}, ${p.currentCommand})`).join("; ")
        throw new Error(
          `Unknown tmux target "${target}".` +
          (sample ? ` Available panes: ${sample}` : " No tmux panes found on server."),
        )
      }
      return paneId
    }

    const tools = {
      tmux_list: tool({
        description:
          "List tmux sessions, windows and panes with live command, AUTO/FREE lock state, @opencode_agent mark, " +
          "subscribers (@collab_subs) and whether this session owns temporary split panes.",
        args: {
          session: tool.schema.string().min(1).optional().describe("Optional tmux session name to filter by"),
        },
        async execute(args, context) {
          const panes = driver.listPanes(args.session)
          const currentPane = process.env.TMUX_PANE
          return JSON.stringify({
            currentPane: currentPane || null,
            paneCount: panes.length,
            panes: panes.map((pane) => ({
              paneId: pane.paneId,
              target: pane.target,
              windowName: pane.windowName,
              command: pane.currentCommand,
              idle: pane.idle,
              dead: pane.dead,
              lock: lockLabel(pane),
              actor: pane.actor || null,
              subscribers: pane.subscribers,
              ownedTempPane: registry.isOwnedPane(pane.paneId, context.sessionID).owned,
              current: currentPane === pane.paneId,
              cwd: pane.cwd,
            })),
          }, null, 2)
        },
      }),

      tmux_send: tool({
        description:
          "Send a command or keys to a tmux pane safely, enforcing the 4-step AUTO/FREE write lock (Ctrl-a L), " +
          "secret/HITL guards, and automatically subscribing this session to shell-return (<tmux-notify>) and " +
          "watchdog (<tmux-watchdog>) notifications. Never poll or sleep after calling this.",
        args: {
          target: tool.schema.string().min(1).describe("Pane ID (%3) or tmux target (session:win.pane)"),
          command: tool.schema.string().min(1).optional().describe("Shell command to type literally and execute (Enter appended by default)"),
          keys: tool.schema.array(tool.schema.string().min(1)).optional().describe("Special tmux key names to send instead of command, e.g. [\"C-c\"]"),
          enter: tool.schema.boolean().optional().describe("Press Enter after command/keys (default: true for command, false for keys)"),
          timeout_s: tool.schema.number().int().min(0).max(86_400).optional().describe("Watchdog interval in seconds (default: 30 for new watch; 0 = completion only)"),
          lines: tool.schema.number().int().min(1).max(1000).optional().describe("Max output lines to capture in notifications (default: 50)"),
        },
        async execute(args, context) {
          if (!args.command && (!args.keys || args.keys.length === 0)) {
            throw new Error("Provide either `command` or `keys` to tmux_send.")
          }
          validateSendPayload({ command: args.command, keys: args.keys })

          const paneId = resolveTargetOrThrow(args.target)
          const allPanes = driver.listPanes()
          const targetPane = allPanes.find((p) => p.paneId === paneId)
          const currentCommand = targetPane?.currentCommand ?? driver.paneCurrentCommand(paneId)
          const forcedFree = targetPane ? targetPane.forcedFree : driver.paneOption(paneId, PANE_STATE_OPTION) === "1"
          const agentMarked = targetPane ? targetPane.agentMarked : driver.paneOption(paneId, PANE_AGENT_OPTION) === "1"

          const gate = evaluateWriteGate({
            paneId,
            forcedFree,
            currentCommand,
            agentMarked,
            idleTargets: allPanes.filter((p) => p.idle && p.paneId !== paneId).slice(0, 6).map((p) => `${p.paneId} (${p.target})`),
          })
          if (!gate.allowed) throw new Error(gate.reason)

          const existingMembers = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
          const alreadyWatching = existingMembers.some((m) => m.sessionID === context.sessionID)
          const explicitTimeout = typeof args.timeout_s === "number"
          const requestedTimeout = explicitTimeout ? args.timeout_s : 30
          const maxLines = args.lines ?? registry.getPaneMeta(paneId)?.maxLines ?? 50

          // Mark pane ownership BEFORE sending keys so concurrent agents see it
          if (!isIdleShell(currentCommand) || (args.command && args.command.trim().length > 0)) {
            driver.setPaneOption(paneId, PANE_AGENT_OPTION, "1")
          }
          driver.setPaneOption(paneId, PANE_ACTOR_OPTION, context.sessionID)

          const { members, resolvedTimeout } = subscribePane(paneId, context.sessionID, requestedTimeout ?? 30, explicitTimeout)
          const existingMeta = registry.getPaneMeta(paneId)
          registry.upsertPaneMeta({
            paneId,
            writerSessionID: existingMeta?.writerSessionID || context.sessionID,
            maxLines,
            armedAtNs: existingMeta?.armedAtNs && existingMeta.armedAtNs > 0n ? existingMeta.armedAtNs : BigInt(Date.now()) * 1_000_000n,
          })

          driver.sendKeys(paneId, {
            command: args.command,
            keys: args.keys,
            enter: args.enter,
          })
          syncEntry(paneId)

          // Announce foreign input to other subscribers of this pane
          const others = existingMembers.filter((m) => m.sessionID !== context.sessionID)
          if (others.length > 0) {
            const sliced = driver.capturePane(paneId, maxLines)
            const subscribers = members.map((m) => m.sessionID)
            for (const other of others) {
              registry.notify(
                other.sessionID,
                paneId,
                notificationFor({
                  paneId,
                  lines: sliced,
                  kind: "foreign-input",
                  actor: context.sessionID,
                  subscribers,
                  self: other.sessionID,
                }),
              )
              void flushSession(other.sessionID)
            }
          }

          const subscriberIDs = members.map((m) => m.sessionID)
          const tag = alreadyWatching
            ? `<tmux-control>\nPane ${paneId} input sent; your watch remains active (timeout ${resolvedTimeout}s). Wait for <tmux-notify>/<tmux-watchdog>.\n</tmux-control>`
            : others.length > 0
              ? `<tmux-shared>\nPane ${paneId} input sent; joined ${describeSubscribers(subscriberIDs, context.sessionID)} (your timeout ${resolvedTimeout}s, lines=${maxLines}). Stop watching with \`tmux_detach({ target: "${paneId}" })\`.\n</tmux-shared>`
              : `<tmux-armed>\nPane ${paneId} armed (timeout ${resolvedTimeout}s, lines=${maxLines}). Continue parallel work or finish your turn: <tmux-notify> arrives automatically on shell return, or <tmux-watchdog> every ${resolvedTimeout}s. Adjust anytime with \`tmux_adjust({ target: "${paneId}", timeout_s: ... })\`.\n</tmux-armed>`

          return `${JSON.stringify({
            paneId,
            target: targetPane?.target ?? args.target,
            gateMode: gate.mode,
            timeoutS: resolvedTimeout,
            lines: maxLines,
            subscribers: subscriberIDs,
          }, null, 2)}\n\n${tag}`
        },
      }),

      tmux_attach: tool({
        description:
          "Subscribe to a tmux pane (read-only watch) without writing to it. You receive <tmux-notify> on shell return, " +
          "<tmux-input> on foreign writes, and <tmux-watchdog> every timeout_s seconds while busy (0 = transitions only).",
        args: {
          target: tool.schema.string().min(1).describe("Pane ID (%3) or tmux target (session:win.pane)"),
          timeout_s: tool.schema.number().int().min(0).max(86_400).optional().describe("Watchdog interval in seconds (default: 0 = transitions only)"),
        },
        async execute(args, context) {
          const paneId = resolveTargetOrThrow(args.target)
          const timeoutS = args.timeout_s ?? 0
          const { members, existed, resolvedTimeout } = subscribePane(paneId, context.sessionID, timeoutS, true)
          syncEntry(paneId)
          return JSON.stringify({
            paneId,
            created: !existed,
            timeoutS: resolvedTimeout,
            command: driver.paneCurrentCommand(paneId),
            subscribers: members.map((m) => m.sessionID),
            note: `Subscribed to pane ${paneId}. Watching is free; you will be notified automatically with zero polling.`,
          }, null, 2)
        },
      }),

      tmux_detach: tool({
        description: "Unsubscribe from a tmux pane without affecting other subscribers or the running command.",
        args: {
          target: tool.schema.string().min(1).describe("Pane ID (%3) or tmux target (session:win.pane)"),
        },
        async execute(args, context) {
          const paneId = resolveTargetOrThrow(args.target)
          const members = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
          const kept = members.filter((m) => m.sessionID !== context.sessionID)
          if (kept.length === 0) {
            driver.unsetPaneOption(paneId, PANE_SUBS_OPTION)
          } else {
            driver.setPaneOption(paneId, PANE_SUBS_OPTION, formatPaneSubs(kept))
          }
          syncEntry(paneId)
          return JSON.stringify({
            paneId,
            removed: kept.length !== members.length,
            remainingSubscribers: kept.map((m) => m.sessionID),
          }, null, 2)
        },
      }),

      tmux_adjust: tool({
        description:
          "Adjust YOUR OWN watchdog timeout interval on a tmux pane you are subscribed to, without sending any input " +
          "to the pane. Replaces the legacy `: TMUX_ADJUST` shell hack.",
        args: {
          target: tool.schema.string().min(1).describe("Pane ID (%3) or tmux target (session:win.pane)"),
          timeout_s: tool.schema.number().int().min(0).max(86_400).describe("New watchdog interval in seconds (0 = completion only)"),
        },
        async execute(args, context) {
          const paneId = resolveTargetOrThrow(args.target)
          const members = parsePaneSubs(driver.paneOption(paneId, PANE_SUBS_OPTION))
          const mine = members.find((m) => m.sessionID === context.sessionID)
          if (!mine) {
            throw new Error(
              `You are not subscribed to pane ${paneId}. Call \`tmux_attach({ target: "${paneId}", timeout_s: ${args.timeout_s} })\` first.`,
            )
          }
          const oldTimeoutS = mine.timeoutS
          subscribePane(paneId, context.sessionID, args.timeout_s, true)
          const entry = syncEntry(paneId)
          const sub = entry?.subs.get(context.sessionID)
          if (sub) {
            sub.timeoutS = args.timeout_s
            sub.count = 0
            sub.nextAt = args.timeout_s > 0 ? Date.now() + args.timeout_s * 1000 : 0
            schedule(paneId)
          }
          return JSON.stringify({
            paneId,
            oldTimeoutS,
            newTimeoutS: args.timeout_s,
            note: `Adjusted your timeout on ${paneId} (${oldTimeoutS}s -> ${args.timeout_s}s). No input sent to the pane.`,
          }, null, 2)
        },
      }),

      tmux_read: tool({
        description:
          "Capture recent output lines from a tmux pane (bounded diagnostic/inspection read; never blocked). " +
          "Do not turn this into a polling loop — prefer tmux_send/tmux_attach notifications.",
        args: {
          target: tool.schema.string().min(1).describe("Pane ID (%3) or tmux target (session:win.pane)"),
          lines: tool.schema.number().int().min(1).max(1000).optional().describe("Number of trailing lines to return (default: 80)"),
          start_line: tool.schema.number().int().optional().describe("Optional tmux -S start line (e.g. -200)"),
        },
        async execute(args) {
          const paneId = resolveTargetOrThrow(args.target)
          const lines = args.lines ?? 80
          const output = driver.capturePane(paneId, lines, args.start_line)
          return JSON.stringify({
            paneId,
            command: driver.paneCurrentCommand(paneId),
            lines: output === "" ? 0 : output.split("\n").length,
            output,
          }, null, 2)
        },
      }),

      tmux_pane: tool({
        description:
          "Create or manage temporary tmux panes/windows/sessions safely. CRITICAL RULE: `kill` is strictly restricted " +
          "to temporary panes created by an agent via this tool — operator panes can never be killed.",
        args: {
          action: tool.schema.enum(["split", "new_window", "new_session", "kill", "rename"]).describe("Lifecycle operation"),
          target: tool.schema.string().min(1).optional().describe("Target pane/window/session depending on action"),
          direction: tool.schema.enum(["horizontal", "vertical"]).optional().describe("Split orientation (default: vertical)"),
          name: tool.schema.string().min(1).optional().describe("Session or window name (for new_session, new_window, rename)"),
          cwd: tool.schema.string().min(1).optional().describe("Working directory for new pane/window/session"),
        },
        async execute(args, context) {
          if (args.action === "split") {
            const startedNs = BigInt(Date.now()) * 1_000_000n
            const target = args.target ?? process.env.TMUX_PANE
            const created = driver.splitPane({ target, direction: args.direction, cwd: args.cwd ?? input.directory })
            registry.recordOwnedPane(created.paneId, context.sessionID)
            const ready = await waitForPaneReady(created.paneId, startedNs)
            return JSON.stringify({ action: "split", ...created, owned: true, ready }, null, 2)
          }
          if (args.action === "new_window") {
            const startedNs = BigInt(Date.now()) * 1_000_000n
            const created = driver.newWindow({ targetSession: args.target, name: args.name, cwd: args.cwd ?? input.directory })
            registry.recordOwnedPane(created.paneId, context.sessionID)
            const ready = await waitForPaneReady(created.paneId, startedNs)
            return JSON.stringify({ action: "new_window", ...created, owned: true, ready }, null, 2)
          }
          if (args.action === "new_session") {
            if (!args.name) throw new Error("`name` is required for action `new_session`.")
            const startedNs = BigInt(Date.now()) * 1_000_000n
            const created = driver.newSession({ name: args.name, cwd: args.cwd ?? input.directory })
            registry.recordOwnedPane(created.paneId, context.sessionID)
            const ready = await waitForPaneReady(created.paneId, startedNs)
            return JSON.stringify({ action: "new_session", ...created, owned: true, ready }, null, 2)
          }
          if (args.action === "rename") {
            if (!args.target || !args.name) throw new Error("`target` and `name` are required for action `rename`.")
            driver.renameWindow(args.target, args.name)
            return JSON.stringify({ action: "rename", target: args.target, name: args.name }, null, 2)
          }
          if (!args.target) throw new Error("`target` is required for action `kill`.")
          const paneId = resolveTargetOrThrow(args.target)
          const ownership = registry.isOwnedPane(paneId)
          if (!ownership.owned) {
            throw new Error(
              `REFUSED: pane ${paneId} was NOT created by an agent (CRITICAL KILL RULE). ` +
              `Agents only kill temporary panes they created themselves.`,
            )
          }
          driver.killPane(paneId)
          registry.removeOwnedPane(paneId)
          registry.deletePaneMeta(paneId)
          dropEntry(paneId)
          return JSON.stringify({ action: "kill", paneId, killed: true }, null, 2)
        },
      }),
    }

    const hooks: Hooks = {
      event: async ({ event }) => {
        const sessionID = "sessionID" in event.properties ? event.properties.sessionID : undefined
        if (event.type === "session.idle" && typeof sessionID === "string") {
          await flushSession(sessionID)
        }
      },

      "chat.message": async (inputMsg, outputMsg) => {
        if (!inputMsg.sessionID || !Array.isArray(outputMsg.parts)) return
        const batch = registry.claimPendingNotices(inputMsg.sessionID)
        if (batch.length === 0) return
        const note = batch.map((n) => n.text).join("\n\n")
        const firstText = outputMsg.parts.find((part) => part.type === "text")
        if (firstText) {
          firstText.text = `${note}\n\n---\n\n${firstText.text}`
        } else {
          outputMsg.parts.unshift({
            id: `prt_${crypto.randomUUID()}`,
            sessionID: inputMsg.sessionID,
            messageID: outputMsg.message.id,
            type: "text",
            text: note,
            synthetic: true,
          })
        }
        registry.markDelivered(batch.map((n) => n.id))
      },

      tool: tools,

      dispose: async () => {
        shutdown.abort()
        try { watcher.stop() } catch {}
        try { reconciler.stop() } catch {}
        for (const paneId of Array.from(localTimers.keys())) dropEntry(paneId)
        registry.close()
      },
    }

    return hooks
  }
}

export default opencodeTmux()
