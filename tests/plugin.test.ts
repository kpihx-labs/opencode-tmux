import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { opencodeTmux, type PaneInfo, type TmuxDriver } from "../src/index.js"
import v2Plugin from "../v2/index.js"

type MockPane = PaneInfo & { options: Record<string, string>; buffer: string }

function makeMockDriver(initial: Array<Partial<MockPane> & { paneId: string }>): {
  driver: TmuxDriver
  panes: Map<string, MockPane>
  sent: Array<{ paneId: string; command?: string; keys?: string[]; enter?: boolean }>
  killed: string[]
} {
  const panes = new Map<string, MockPane>()
  let nextPane = 50
  for (const item of initial) {
    panes.set(item.paneId, {
      paneId: item.paneId,
      sessionName: item.sessionName ?? "dev",
      windowIndex: item.windowIndex ?? 0,
      windowName: item.windowName ?? "main",
      paneIndex: item.paneIndex ?? 0,
      target: item.target ?? `dev:0.${panes.size}`,
      currentCommand: item.currentCommand ?? "zsh",
      idle: (item.currentCommand ?? "zsh") === "zsh",
      dead: item.dead ?? false,
      width: 120,
      height: 40,
      cwd: "/work",
      forcedFree: item.forcedFree ?? false,
      agentMarked: item.agentMarked ?? false,
      actor: item.actor ?? "",
      subscribers: item.subscribers ?? [],
      options: { ...(item.options ?? {}) },
      buffer: item.buffer ?? "line1\nline2",
    })
  }
  const sent: Array<{ paneId: string; command?: string; keys?: string[]; enter?: boolean }> = []
  const killed: string[] = []

  const driver: TmuxDriver = {
    listPanes(sessionFilter) {
      return Array.from(panes.values())
        .filter((p) => !sessionFilter || p.sessionName === sessionFilter)
        .map((p) => ({
          ...p,
          idle: ["zsh", "bash", "sh", "fish", ""].includes(p.currentCommand),
          forcedFree: p.options["@state"] === "1",
          agentMarked: p.options["@opencode_agent"] === "1",
          actor: p.options["@collab_actor"] ?? "",
          subscribers: (p.options["@collab_subs"] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const [sid, t] = s.split(":")
              return { sessionID: sid, timeoutS: Number.parseInt(t ?? "0", 10) || 0 }
            }),
        }))
    },
    resolvePane(target) {
      if (panes.has(target)) return target
      for (const p of panes.values()) if (p.target === target) return p.paneId
      return null
    },
    paneExists(paneId) {
      return panes.has(paneId)
    },
    paneCurrentCommand(paneId) {
      return panes.get(paneId)?.currentCommand ?? ""
    },
    paneOption(paneId, name) {
      return panes.get(paneId)?.options[name] ?? ""
    },
    setPaneOption(paneId, name, value) {
      const p = panes.get(paneId)
      if (!p) return false
      p.options[name] = value
      return true
    },
    unsetPaneOption(paneId, name) {
      const p = panes.get(paneId)
      if (!p) return false
      delete p.options[name]
      return true
    },
    capturePane(paneId, lines = 50) {
      const p = panes.get(paneId)
      if (!p) return ""
      return p.buffer.split("\n").slice(-lines).join("\n")
    },
    sendKeys(paneId, input) {
      sent.push({ paneId, ...input })
    },
    splitPane() {
      const paneId = `%${++nextPane}`
      const target = `dev:0.${nextPane}`
      panes.set(paneId, {
        paneId, sessionName: "dev", windowIndex: 0, windowName: "main", paneIndex: nextPane, target,
        currentCommand: "zsh", idle: true, dead: false, width: 120, height: 40, cwd: "/work",
        forcedFree: false, agentMarked: false, actor: "", subscribers: [], options: {}, buffer: "",
      })
      return { paneId, target }
    },
    newWindow({ name }) {
      const paneId = `%${++nextPane}`
      const target = `dev:${nextPane}.0`
      panes.set(paneId, {
        paneId, sessionName: "dev", windowIndex: nextPane, windowName: name ?? "win", paneIndex: 0, target,
        currentCommand: "zsh", idle: true, dead: false, width: 120, height: 40, cwd: "/work",
        forcedFree: false, agentMarked: false, actor: "", subscribers: [], options: {}, buffer: "",
      })
      return { paneId, target }
    },
    newSession({ name }) {
      const paneId = `%${++nextPane}`
      const target = `${name}:0.0`
      panes.set(paneId, {
        paneId, sessionName: name, windowIndex: 0, windowName: "main", paneIndex: 0, target,
        currentCommand: "zsh", idle: true, dead: false, width: 120, height: 40, cwd: "/work",
        forcedFree: false, agentMarked: false, actor: "", subscribers: [], options: {}, buffer: "",
      })
      return { paneId, target }
    },
    killPane(paneId) {
      killed.push(paneId)
      panes.delete(paneId)
    },
    renameWindow() {},
  }
  return { driver, panes, sent, killed }
}

function makeClient() {
  const deliveries: Array<{ sessionID: string; text: string }> = []
  const client = {
    session: {
      promptAsync: async (req: { path: { id: string }; body: { parts: Array<{ text: string }> } }) => {
        deliveries.push({ sessionID: req.path.id, text: req.body.parts[0].text })
        return { data: undefined }
      },
    },
  }
  return { client, deliveries }
}

describe("opencode-tmux tools & bus", () => {
  test("tmux_list, tmux_send (AUTO/FREE gate), tmux_attach, tmux_adjust, tmux_detach, tmux_read", async () => {
    const logPath = `/tmp/opencode/tmux-done-${crypto.randomUUID()}.log`
    const dbPath = `/tmp/opencode/tmux-db-${crypto.randomUUID()}.sqlite`
    const { driver, panes, sent } = makeMockDriver([
      { paneId: "%1", target: "dev:0.0", currentCommand: "zsh", buffer: "out-a\nout-b" },
      { paneId: "%2", target: "dev:0.1", currentCommand: "nvim" },
      { paneId: "%3", target: "dev:0.2", currentCommand: "ssh", options: { "@state": "1" } },
    ])
    const { client, deliveries } = makeClient()
    const hooks = await opencodeTmux({ driver, databasePath: dbPath, notifyLogPath: logPath, logPollMs: 50, reconcileMs: 5_000 })({
      client: client as never,
      directory: "/work",
    } as never)

    const tools = hooks.tool
    if (!tools) throw new Error("tools missing")
    const ctxA = { sessionID: "ses_a", agent: "Live", directory: "/work", abort: new AbortController().signal } as never
    const ctxB = { sessionID: "ses_b", agent: "Live", directory: "/work", abort: new AbortController().signal } as never

    // 1. tmux_list
    const listOut = JSON.parse(await tools.tmux_list.execute({}, ctxA))
    expect(listOut.paneCount).toBe(3)
    expect(listOut.panes.find((p: { paneId: string }) => p.paneId === "%2").lock).toBe("LOCKED")
    expect(listOut.panes.find((p: { paneId: string }) => p.paneId === "%3").lock).toBe("FREE")

    // 2. LOCKED pane blocks loudly and suggests idle %1
    await expect(tools.tmux_send.execute({ target: "%2", command: "ls" }, ctxA)).rejects.toThrow("BLOCKED: pane %2")

    // 3. FREE pane (%3) allows even when occupied by ssh
    const freeRes = await tools.tmux_send.execute({ target: "%3", command: "hostname", timeout_s: 15 }, ctxA)
    expect(freeRes).toContain("<tmux-armed>")
    expect(panes.get("%3")?.options["@opencode_agent"]).toBe("1")

    // 4. Session B attaches read-only to %1 with its own timeout, Session A sends command
    await tools.tmux_attach.execute({ target: "%1", timeout_s: 120 }, ctxB)
    const sendRes = await tools.tmux_send.execute({ target: "%1", command: "echo hi", timeout_s: 45, lines: 10 }, ctxA)
    expect(sendRes).toContain("<tmux-shared>")
    expect(sent.find((s) => s.paneId === "%1")?.command).toBe("echo hi")
    expect(panes.get("%1")?.options["@collab_subs"]).toBe("ses_b:120,ses_a:45")

    // B should get foreign-input notification
    await Bun.sleep(20)
    expect(deliveries.some((d) => d.sessionID === "ses_b" && d.text.includes("<tmux-input>"))).toBe(true)

    // 5. Session A adjusts its own timeout without touching B's 120s
    const adj = JSON.parse(await tools.tmux_adjust.execute({ target: "%1", timeout_s: 90 }, ctxA))
    expect(adj).toMatchObject({ oldTimeoutS: 45, newTimeoutS: 90 })
    expect(panes.get("%1")?.options["@collab_subs"]).toBe("ses_b:120,ses_a:90")

    // 6. Session B detaches; A stays subscribed
    const det = JSON.parse(await tools.tmux_detach.execute({ target: "%1" }, ctxB))
    expect(det).toMatchObject({ removed: true, remainingSubscribers: ["ses_a"] })

    // 7. tmux_read diagnostic capture works
    const readOut = JSON.parse(await tools.tmux_read.execute({ target: "%1", lines: 5 }, ctxA))
    expect(readOut.output).toBe("out-a\nout-b")

    // 8. Shell prompt return event in log triggers single <tmux-notify> & clears options
    fs.appendFileSync(logPath, `${JSON.stringify({ event: "prompt", pane: "%1", ts: 999001 })}\n`)
    await Bun.sleep(120)
    const finalA = deliveries.filter((d) => d.sessionID === "ses_a" && d.text.includes("<tmux-notify>") && d.text.includes("%1"))
    expect(finalA).toHaveLength(1)
    expect(finalA[0].text).toContain("Last 2 output lines:")
    expect(panes.get("%1")?.options["@collab_subs"]).toBeUndefined()
    expect(panes.get("%1")?.options["@opencode_agent"]).toBeUndefined()

    await hooks.dispose?.()
  })

  test("tmux_pane split/kill enforces CRITICAL KILL RULE (only agent-created panes can be killed)", async () => {
    const { driver, killed } = makeMockDriver([{ paneId: "%1", target: "dev:0.0", currentCommand: "zsh" }])
    const { client } = makeClient()
    const hooks = await opencodeTmux({
      driver,
      databasePath: ":memory:",
      notifyLogPath: `/tmp/opencode/tmux-done-${crypto.randomUUID()}.log`,
      reconcileMs: 5_000,
    })({ client: client as never, directory: "/work" } as never)
    const ctx = { sessionID: "ses_a", agent: "Live", directory: "/work", abort: new AbortController().signal } as never
    const paneTool = hooks.tool?.tmux_pane
    if (!paneTool) throw new Error("tmux_pane missing")

    await expect(paneTool.execute({ action: "kill", target: "%1" }, ctx)).rejects.toThrow("CRITICAL KILL RULE")

    const split = JSON.parse(await paneTool.execute({ action: "split" }, ctx))
    expect(split.owned).toBe(true)
    const kill = JSON.parse(await paneTool.execute({ action: "kill", target: split.paneId }, ctx))
    expect(kill.killed).toBe(true)
    expect(killed).toEqual([split.paneId])

    await hooks.dispose?.()
  })

  test("cross-instance SQLite dedup ensures N instances emit 1 <tmux-notify> per prompt event", async () => {
    const logPath = `/tmp/opencode/tmux-multi-${crypto.randomUUID()}.log`
    const dbPath = `/tmp/opencode/tmux-multi-${crypto.randomUUID()}.sqlite`
    const { driver } = makeMockDriver([{ paneId: "%7", target: "dev:0.0", currentCommand: "zsh", buffer: "DONE_LINE" }])
    const { client, deliveries } = makeClient()
    const h1 = await opencodeTmux({ driver, databasePath: dbPath, notifyLogPath: logPath, logPollMs: 50, reconcileMs: 5_000 })({
      client: client as never, directory: "/work/a",
    } as never)
    const h2 = await opencodeTmux({ driver, databasePath: dbPath, notifyLogPath: logPath, logPollMs: 50, reconcileMs: 5_000 })({
      client: client as never, directory: "/work/b",
    } as never)

    const ctx = { sessionID: "ses_owner", agent: "Live", directory: "/work/a", abort: new AbortController().signal } as never
    await h1.tool?.tmux_send.execute({ target: "%7", command: "echo ok" }, ctx)
    fs.appendFileSync(logPath, `${JSON.stringify({ event: "prompt", pane: "%7", ts: 777111 })}\n`)
    await Bun.sleep(150)

    const finals = deliveries.filter((d) => d.sessionID === "ses_owner" && d.text.includes("<tmux-notify>"))
    expect(finals).toHaveLength(1)

    await h1.dispose?.()
    await h2.dispose?.()
  })

  test("v2 adapter registers all 7 tmux tools cleanly", async () => {
    const added: string[] = []
    const cleanup = await v2Plugin.setup({
      location: { directory: "/tmp/opencode" },
      options: { databasePath: ":memory:", notifyLogPath: `/tmp/opencode/tmux-v2-${crypto.randomUUID()}.log` },
      session: { hook: async () => {}, synthetic: async () => {}, prompt: async () => {} },
      tool: {
        transform: async (fn: (editor: { add: (t: { name: string }) => void }) => void) => {
          fn({ add: (t) => added.push(t.name) })
        },
      },
      event: {
        subscribe: async function* () {},
      },
    })
    expect(added.sort()).toEqual(["tmux_adjust", "tmux_attach", "tmux_detach", "tmux_list", "tmux_pane", "tmux_read", "tmux_send"])
    if (typeof cleanup === "function") cleanup()
  })
})
