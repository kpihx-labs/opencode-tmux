import { execFileSync } from "node:child_process"
import {
  isIdleShell,
  PANE_ACTOR_OPTION,
  PANE_AGENT_OPTION,
  PANE_STATE_OPTION,
  PANE_SUBS_OPTION,
  type PaneSubscriber,
  parsePaneSubs,
} from "./patterns.js"

export type PaneInfo = {
  paneId: string
  sessionName: string
  windowIndex: number
  windowName: string
  paneIndex: number
  target: string
  currentCommand: string
  idle: boolean
  dead: boolean
  width: number
  height: number
  cwd: string
  forcedFree: boolean
  agentMarked: boolean
  actor: string
  subscribers: PaneSubscriber[]
}

export interface TmuxDriver {
  listPanes(sessionFilter?: string): PaneInfo[]
  resolvePane(target: string): string | null
  paneExists(paneId: string): boolean
  paneCurrentCommand(paneId: string): string
  paneOption(paneId: string, name: string): string
  setPaneOption(paneId: string, name: string, value: string): boolean
  unsetPaneOption(paneId: string, name: string): boolean
  capturePane(paneId: string, lines?: number, startLine?: number): string
  sendKeys(paneId: string, input: { command?: string; keys?: string[]; enter?: boolean }): void
  splitPane(input: { target?: string; direction?: "horizontal" | "vertical"; cwd?: string }): { paneId: string; target: string }
  newWindow(input: { targetSession?: string; name?: string; cwd?: string }): { paneId: string; target: string }
  newSession(input: { name: string; cwd?: string }): { paneId: string; target: string }
  killPane(paneId: string): void
  renameWindow(target: string, name: string): void
}

const TIMEOUT_MS = 3000

function runTmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", timeout: TIMEOUT_MS })
}

const LIST_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_current_command}",
  "#{pane_dead}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_current_path}",
  `#{${PANE_STATE_OPTION}}`,
  `#{${PANE_AGENT_OPTION}}`,
  `#{${PANE_ACTOR_OPTION}}`,
  `#{${PANE_SUBS_OPTION}}`,
].join("\t")

export class ExecTmuxDriver implements TmuxDriver {
  listPanes(sessionFilter?: string): PaneInfo[] {
    const args = sessionFilter
      ? ["list-panes", "-s", "-t", sessionFilter, "-F", LIST_FORMAT]
      : ["list-panes", "-a", "-F", LIST_FORMAT]
    let out = ""
    try {
      out = runTmux(args)
    } catch {
      return []
    }
    const panes: PaneInfo[] = []
    for (const line of out.split("\n")) {
      if (!line.trim()) continue
      const cols = line.split("\t")
      if (cols.length < 14) continue
      const [
        paneId,
        sessionName,
        winIdxRaw,
        windowName,
        paneIdxRaw,
        currentCommand,
        deadRaw,
        widthRaw,
        heightRaw,
        cwd,
        stateOpt,
        agentOpt,
        actorOpt,
        subsOpt,
      ] = cols
      const windowIndex = Number.parseInt(winIdxRaw, 10) || 0
      const paneIndex = Number.parseInt(paneIdxRaw, 10) || 0
      panes.push({
        paneId,
        sessionName,
        windowIndex,
        windowName,
        paneIndex,
        target: `${sessionName}:${windowIndex}.${paneIndex}`,
        currentCommand,
        idle: isIdleShell(currentCommand),
        dead: deadRaw === "1",
        width: Number.parseInt(widthRaw, 10) || 0,
        height: Number.parseInt(heightRaw, 10) || 0,
        cwd,
        forcedFree: stateOpt === "1",
        agentMarked: agentOpt === "1",
        actor: actorOpt ?? "",
        subscribers: parsePaneSubs(subsOpt),
      })
    }
    return panes
  }

  resolvePane(target: string): string | null {
    const trimmed = target.trim()
    if (!trimmed) return null
    try {
      const resolved = runTmux(["display-message", "-p", "-t", trimmed, "#{pane_id}"]).trim()
      return resolved.startsWith("%") ? resolved : null
    } catch {
      return null
    }
  }

  paneExists(paneId: string): boolean {
    const resolved = this.resolvePane(paneId)
    return resolved === paneId
  }

  paneCurrentCommand(paneId: string): string {
    try {
      return runTmux(["display-message", "-p", "-t", paneId, "#{pane_current_command}"]).trim()
    } catch {
      return ""
    }
  }

  paneOption(paneId: string, name: string): string {
    try {
      return runTmux(["show-options", "-pqv", "-t", paneId, name]).trim()
    } catch {
      return ""
    }
  }

  setPaneOption(paneId: string, name: string, value: string): boolean {
    try {
      runTmux(["set-option", "-pt", paneId, name, value])
      return true
    } catch {
      return false
    }
  }

  unsetPaneOption(paneId: string, name: string): boolean {
    try {
      runTmux(["set-option", "-pu", "-t", paneId, name])
      return true
    } catch {
      return false
    }
  }

  capturePane(paneId: string, lines = 50, startLine?: number): string {
    try {
      const args = ["capture-pane", "-p", "-t", paneId]
      if (typeof startLine === "number" && Number.isFinite(startLine)) {
        args.push("-S", String(Math.floor(startLine)))
      } else if (lines > 0) {
        args.push("-S", `-${Math.max(lines, 10)}`)
      }
      const raw = runTmux(args)
      const split = raw.replace(/\n+$/, "").split("\n")
      return split.slice(-Math.max(lines, 1)).join("\n")
    } catch (error) {
      return `(failed to capture pane: ${error instanceof Error ? error.message : String(error)})`
    }
  }

  sendKeys(paneId: string, input: { command?: string; keys?: string[]; enter?: boolean }): void {
    if (input.command !== undefined && input.command.length > 0) {
      // `-l` sends literal characters without tmux interpreting key names like "Enter" or "Space".
      runTmux(["send-keys", "-t", paneId, "-l", input.command])
      if (input.enter !== false) {
        runTmux(["send-keys", "-t", paneId, "Enter"])
      }
      return
    }
    if (input.keys && input.keys.length > 0) {
      runTmux(["send-keys", "-t", paneId, ...input.keys])
      if (input.enter === true) {
        runTmux(["send-keys", "-t", paneId, "Enter"])
      }
    }
  }

  splitPane(input: { target?: string; direction?: "horizontal" | "vertical"; cwd?: string }): { paneId: string; target: string } {
    const args = ["split-window", "-P", "-F", "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}"]
    args.push(input.direction === "horizontal" ? "-h" : "-v")
    if (input.target) args.push("-t", input.target)
    if (input.cwd) args.push("-c", input.cwd)
    const [paneId, target] = runTmux(args).trim().split("\t")
    return { paneId, target: target || paneId }
  }

  newWindow(input: { targetSession?: string; name?: string; cwd?: string }): { paneId: string; target: string } {
    const args = ["new-window", "-P", "-F", "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}"]
    if (input.targetSession) args.push("-t", input.targetSession)
    if (input.name) args.push("-n", input.name)
    if (input.cwd) args.push("-c", input.cwd)
    const [paneId, target] = runTmux(args).trim().split("\t")
    return { paneId, target: target || paneId }
  }

  newSession(input: { name: string; cwd?: string }): { paneId: string; target: string } {
    const args = ["new-session", "-d", "-s", input.name, "-P", "-F", "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}"]
    if (input.cwd) args.push("-c", input.cwd)
    const [paneId, target] = runTmux(args).trim().split("\t")
    return { paneId, target: target || paneId }
  }

  killPane(paneId: string): void {
    runTmux(["kill-pane", "-t", paneId])
  }

  renameWindow(target: string, name: string): void {
    runTmux(["rename-window", "-t", target, name])
  }
}
