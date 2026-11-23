import { afterEach, describe, expect, test } from "bun:test"
import { TmuxRegistry } from "../src/registry.js"

const createdPaths: string[] = []
afterEach(() => {
  // clean closes handled inline; keep /tmp/opencode clean via unique files
})

describe("TmuxRegistry", () => {
  test("reopens file-backed database transparently after close()", () => {
    const path = `/tmp/opencode/tmux-reopen-${crypto.randomUUID()}.sqlite`
    createdPaths.push(path)
    const db = new TmuxRegistry(path)
    db.upsertPaneMeta({ paneId: "%3", writerSessionID: "ses_1", maxLines: 40, armedAtNs: 123n })
    db.close()
    expect(db.getPaneMeta("%3")?.maxLines).toBe(40)
    db.close()
  })

  test("claimEvent deduplicates atomically across multiple instances sharing one sqlite file", () => {
    const path = `/tmp/opencode/tmux-claim-${crypto.randomUUID()}.sqlite`
    const a = new TmuxRegistry(path)
    const b = new TmuxRegistry(path)
    try {
      expect(a.claimEvent("prompt:%3:1001")).toBe(true)
      expect(b.claimEvent("prompt:%3:1001")).toBe(false)
      expect(b.claimEvent("prompt:%3:1002")).toBe(true)
    } finally {
      a.close()
      b.close()
    }
  })

  test("owned_panes tracks agent-created panes and pending_notify claims atomically", () => {
    const db = new TmuxRegistry(":memory:")
    try {
      db.recordOwnedPane("%99", "ses_a")
      expect(db.isOwnedPane("%99")).toEqual({ owned: true, ownerSessionID: "ses_a" })
      expect(db.isOwnedPane("%1")).toEqual({ owned: false })
      db.removeOwnedPane("%99")
      expect(db.isOwnedPane("%99")).toEqual({ owned: false })

      const id = db.notify("ses_a", "%3", "hello")
      const claimed = db.claimPendingNotices("ses_a")
      expect(claimed).toHaveLength(1)
      expect(claimed[0].id).toBe(id)
      // Second concurrent claim gets nothing while first is in flight
      expect(db.claimPendingNotices("ses_a")).toHaveLength(0)
      db.releaseClaims([id])
      expect(db.claimPendingNotices("ses_a")).toHaveLength(1)
      db.markDelivered([id])
      expect(db.pendingCount("ses_a")).toBe(0)
    } finally {
      db.close()
    }
  })
})
