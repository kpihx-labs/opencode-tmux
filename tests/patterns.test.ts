import { describe, expect, test } from "bun:test"
import {
  evaluateWriteGate,
  formatPaneSubs,
  parsePaneSubs,
  splitCompleteLogLines,
  validateSendPayload,
} from "../src/patterns.js"

describe("pane subscription codec", () => {
  test("parses and round-trips multi-subscriber timeouts", () => {
    const parsed = parsePaneSubs("ses_a:30, ses_b:0, ses_c")
    expect(parsed).toEqual([
      { sessionID: "ses_a", timeoutS: 30 },
      { sessionID: "ses_b", timeoutS: 0 },
      { sessionID: "ses_c", timeoutS: 0 },
    ])
    expect(formatPaneSubs(parsed)).toBe("ses_a:30,ses_b:0,ses_c:0")
    expect(parsePaneSubs("")).toEqual([])
    expect(formatPaneSubs([])).toBe("")
  })
})

describe("splitCompleteLogLines", () => {
  test("preserves torn lines across log reads", () => {
    const p1 = splitCompleteLogLines("", '{"event":"prompt"')
    expect(p1).toEqual({ completeLines: [], remainder: '{"event":"prompt"' })
    const p2 = splitCompleteLogLines(p1.remainder, ',"pane":"%7"}\n')
    expect(p2).toEqual({ completeLines: ['{"event":"prompt","pane":"%7"}'], remainder: "" })
  })
})

describe("AUTO/FREE write gate", () => {
  test("allows FREE (@state=1), idle shells, and agent-marked panes; blocks operator panes", () => {
    expect(evaluateWriteGate({ paneId: "%1", forcedFree: true, currentCommand: "ssh", agentMarked: false })).toEqual({ allowed: true, mode: "free" })
    expect(evaluateWriteGate({ paneId: "%1", forcedFree: false, currentCommand: "zsh", agentMarked: false })).toEqual({ allowed: true, mode: "idle" })
    expect(evaluateWriteGate({ paneId: "%1", forcedFree: false, currentCommand: "python3", agentMarked: true })).toEqual({ allowed: true, mode: "agent_shared" })

    const blocked = evaluateWriteGate({
      paneId: "%1",
      forcedFree: false,
      currentCommand: "nvim",
      agentMarked: false,
      idleTargets: ["%2 (dev:0.1)"],
    })
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) {
      expect(blocked.reason).toContain("Ctrl-a L")
      expect(blocked.reason).toContain("%2 (dev:0.1)")
    }
  })
})

describe("validateSendPayload", () => {
  test("blocks bare HITL confirm pre-injection and inline secret headers, allows piped authorized mutation", () => {
    expect(() => validateSendPayload({ command: "y" })).toThrow("HITL confirmation")
    expect(() => validateSendPayload({ keys: ["yes", "Enter"] })).toThrow("HITL confirmation")
    expect(() => validateSendPayload({ command: 'curl -H "Authorization: Bearer $CF_TOKEN" https://api.example.com' })).toThrow("with-env curls")
    expect(() => validateSendPayload({ command: "cat .env" })).toThrow("secrets zero-touch")

    expect(() => validateSendPayload({ command: 'printf "y\\n" | with-env curls -p cloudflare -X POST https://api.example.com' })).not.toThrow()
    expect(() => validateSendPayload({ command: "cat .env.example" })).not.toThrow()
  })
})
