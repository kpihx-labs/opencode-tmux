import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

type Bindings = Extract<SQLQueryBindings, Record<string, unknown>>

export type PaneMeta = {
  paneId: string
  writerSessionID: string
  maxLines: number
  armedAtNs: bigint
}

export type PendingNotice = {
  id: string
  sessionID: string
  paneId: string
  text: string
  createdAt: number
}

/**
 * Durable SQLite coordinator for `opencode-tmux`.
 *
 * Authoritative pane state (`@state`, `@opencode_agent`, `@collab_subs`,
 * `@collab_actor`) lives IN TMUX so every process sees it with zero IPC.
 * This registry handles what tmux options cannot express cleanly across N
 * OpenCode location instances:
 *   - Cross-instance atomic CAS deduplication (`claimEvent`) so N plugin instances
 *     watching the same `/tmp/tmux-pane-done.log` produce 1 notification, never N;
 *   - Per-pane metadata (`maxLines`, `armedAtNs`, `writerSessionID`);
 *   - Ownership of temporary split panes (`owned_panes`) enforcing the rule
 *     that agents only kill panes they created themselves;
 *   - Durable per-session notification queue (`pending_notify`) surviving reloads.
 */
export class TmuxRegistry {
  #path: string
  #db!: Database
  #closed = false

  constructor(path: string) {
    this.#path = path
    this.#open()
  }

  get #conn(): Database {
    if (this.#closed) {
      if (this.#path === ":memory:") throw new Error("Cannot use a closed in-memory database")
      this.#open()
    }
    return this.#db
  }

  #open() {
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true })
    this.#db = new Database(this.#path, { create: true })
    this.#closed = false
    this.#db.run("PRAGMA journal_mode = WAL")
    this.#db.run("PRAGMA busy_timeout = 5000")
    this.#db.run(`CREATE TABLE IF NOT EXISTS pane_meta (
      pane_id TEXT PRIMARY KEY,
      writer_session_id TEXT NOT NULL DEFAULT '',
      max_lines INTEGER NOT NULL DEFAULT 50,
      armed_at_ns TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS owned_panes (
      pane_id TEXT PRIMARY KEY,
      owner_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS pending_notify (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      pane_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      delivered_at INTEGER
    )`)
    this.#db.run(`CREATE TABLE IF NOT EXISTS dedup_claims (
      claim_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`)
    this.#db.run("CREATE INDEX IF NOT EXISTS notify_pending_idx ON pending_notify(session_id, delivered_at, created_at)")
    this.#db.run("CREATE INDEX IF NOT EXISTS dedup_ts_idx ON dedup_claims(created_at)")
  }

  // ---- pane metadata -------------------------------------------------------

  upsertPaneMeta(meta: { paneId: string; writerSessionID?: string; maxLines?: number; armedAtNs?: bigint }) {
    const existing = this.getPaneMeta(meta.paneId)
    const writer = meta.writerSessionID ?? existing?.writerSessionID ?? ""
    const maxLines = meta.maxLines ?? existing?.maxLines ?? 50
    const armedAtNs = (meta.armedAtNs ?? existing?.armedAtNs ?? 0n).toString()
    this.#conn.query(`INSERT INTO pane_meta (pane_id, writer_session_id, max_lines, armed_at_ns, updated_at)
      VALUES ($pane, $writer, $lines, $armed, $now)
      ON CONFLICT(pane_id) DO UPDATE SET
        writer_session_id = excluded.writer_session_id,
        max_lines = excluded.max_lines,
        armed_at_ns = excluded.armed_at_ns,
        updated_at = excluded.updated_at`).run({
      $pane: meta.paneId,
      $writer: writer,
      $lines: maxLines,
      $armed: armedAtNs,
      $now: Date.now(),
    })
  }

  getPaneMeta(paneId: string): PaneMeta | undefined {
    const row = this.#conn.query<{
      pane_id: string
      writer_session_id: string
      max_lines: number
      armed_at_ns: string
    }, Bindings>("SELECT * FROM pane_meta WHERE pane_id = $pane").get({ $pane: paneId })
    if (!row) return undefined
    let armedAtNs = 0n
    try { armedAtNs = BigInt(row.armed_at_ns) } catch {}
    return {
      paneId: row.pane_id,
      writerSessionID: row.writer_session_id,
      maxLines: Number(row.max_lines) || 50,
      armedAtNs,
    }
  }

  deletePaneMeta(paneId: string) {
    this.#conn.query("DELETE FROM pane_meta WHERE pane_id = $pane").run({ $pane: paneId })
  }

  // ---- owned temporary panes (CRITICAL KILL RULE) --------------------------

  recordOwnedPane(paneId: string, ownerSessionID: string) {
    this.#conn.query("INSERT OR REPLACE INTO owned_panes (pane_id, owner_session_id, created_at) VALUES ($pane, $owner, $now)")
      .run({ $pane: paneId, $owner: ownerSessionID, $now: Date.now() })
  }

  isOwnedPane(paneId: string, sessionID?: string): { owned: boolean; ownerSessionID?: string } {
    const row = this.#conn.query<{ owner_session_id: string }, Bindings>(
      "SELECT owner_session_id FROM owned_panes WHERE pane_id = $pane",
    ).get({ $pane: paneId })
    if (!row) return { owned: false }
    if (sessionID && row.owner_session_id !== sessionID) {
      return { owned: true, ownerSessionID: row.owner_session_id }
    }
    return { owned: true, ownerSessionID: row.owner_session_id }
  }

  removeOwnedPane(paneId: string) {
    this.#conn.query("DELETE FROM owned_panes WHERE pane_id = $pane").run({ $pane: paneId })
  }

  // ---- cross-instance CAS deduplication ------------------------------------

  claimEvent(key: string): boolean {
    const now = Date.now()
    // Prune stale claims older than 24h occasionally
    if (now % 97 === 0) {
      this.#conn.query("DELETE FROM dedup_claims WHERE created_at < $cutoff").run({ $cutoff: now - 86_400_000 })
    }
    return this.#conn.query("INSERT OR IGNORE INTO dedup_claims (claim_key, created_at) VALUES ($key, $now)")
      .run({ $key: key, $now: now }).changes === 1
  }

  // ---- durable per-session notifications -----------------------------------

  notify(sessionID: string, paneId: string, text: string): string {
    const id = `tntf_${crypto.randomUUID()}`
    this.#conn.query("INSERT INTO pending_notify (id, session_id, pane_id, text, created_at) VALUES ($id, $session, $pane, $text, $now)")
      .run({ $id: id, $session: sessionID, $pane: paneId, $text: text, $now: Date.now() })
    return id
  }

  claimPendingNotices(sessionID: string, limit = 20): PendingNotice[] {
    const now = Date.now()
    const stale = now - 30_000
    return this.#conn.transaction(() => {
      const rows = this.#conn.query<{
        id: string
        session_id: string
        pane_id: string
        text: string
        created_at: number
      }, Bindings>(
        `SELECT id, session_id, pane_id, text, created_at FROM pending_notify
         WHERE session_id = $session AND delivered_at IS NULL AND (claimed_at IS NULL OR claimed_at < $stale)
         ORDER BY created_at LIMIT $limit`,
      ).all({ $session: sessionID, $stale: stale, $limit: limit })
      if (rows.length > 0) {
        const mark = this.#conn.query("UPDATE pending_notify SET claimed_at = $now WHERE id = $id")
        for (const row of rows) mark.run({ $id: row.id, $now: now })
      }
      return rows.map((row) => ({
        id: row.id,
        sessionID: row.session_id,
        paneId: row.pane_id,
        text: row.text,
        createdAt: Number(row.created_at),
      }))
    })()
  }

  markDelivered(ids: string[]) {
    if (ids.length === 0) return
    const now = Date.now()
    const stmt = this.#conn.query("UPDATE pending_notify SET delivered_at = $now WHERE id = $id")
    this.#conn.transaction(() => {
      for (const id of ids) stmt.run({ $id: id, $now: now })
    })()
  }

  releaseClaims(ids: string[]) {
    if (ids.length === 0) return
    const stmt = this.#conn.query("UPDATE pending_notify SET claimed_at = NULL WHERE id = $id AND delivered_at IS NULL")
    this.#conn.transaction(() => {
      for (const id of ids) stmt.run({ $id: id })
    })()
  }

  sessionsWithNotices(): string[] {
    return this.#conn.query<{ session_id: string }, Bindings>(
      "SELECT DISTINCT session_id FROM pending_notify WHERE delivered_at IS NULL",
    ).all({}).map((row) => row.session_id)
  }

  pendingCount(sessionID: string): number {
    return this.#conn.query<{ count: number }, Bindings>(
      "SELECT COUNT(*) AS count FROM pending_notify WHERE session_id = $session AND delivered_at IS NULL",
    ).get({ $session: sessionID })?.count ?? 0
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    try { this.#db.close() } catch {}
  }
}
