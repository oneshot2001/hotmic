import type { Database } from "bun:sqlite";
import { payloadHash, validAlias, type Level } from "./egress";

export type Refs = { workspace_ref: string | null; surface_ref: string | null };
export type Session = Refs & { alias: string; cwd: string; token_hash: string; level: Level;
  connected: boolean; last_heartbeat: number; send?: (value: unknown) => void; ready?: boolean };
export const emptyRefs = (): Refs => ({ workspace_ref: null, surface_ref: null });
export function validRefs(value: Refs) {
  return [value.workspace_ref, value.surface_ref].every(v => v === null || (typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v)));
}
export class Registry {
  #rows = new Map<string, Session>();
  constructor(private db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS sessions (alias TEXT PRIMARY KEY, cwd TEXT NOT NULL, token_hash TEXT NOT NULL)");
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map(c => c.name));
    for (const [name, definition] of Object.entries({ workspace_ref: "TEXT", surface_ref: "TEXT", level: "TEXT NOT NULL DEFAULT 'off'",
      connected: "INTEGER NOT NULL DEFAULT 0", last_heartbeat: "REAL NOT NULL DEFAULT 0" })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
    }
    db.exec("UPDATE sessions SET connected = 0");
    for (const row of db.query<Session, []>("SELECT * FROM sessions").all()) this.#rows.set(row.alias, { ...row, connected: false });
  }
  get size() { return this.#rows.size; }
  get(alias: string) { return this.#rows.get(alias); }
  values() { return this.#rows.values(); }
  keys() { return this.#rows.keys(); }
  has(alias: string) { return this.#rows.has(alias); }
  register(alias: string, cwd: string, token: string, level: Level, refs: Refs = emptyRefs()) {
    if (!validAlias(alias) || !/^[a-f0-9]{64}$/.test(token) || !validRefs(refs)) throw new Error("Invalid registration");
    const previous = this.get(alias), hash = payloadHash(token);
    if (previous?.connected && previous.token_hash !== hash) throw new Error("Alias already registered with a different token");
    if (!previous && this.size >= 8) throw new Error("Maximum 8 sessions");
    if (previous?.token_hash === hash && (previous.cwd !== cwd || previous.workspace_ref !== refs.workspace_ref || previous.surface_ref !== refs.surface_ref)) throw new Error("Registered identity changed");
    const row: Session = previous?.token_hash === hash ? previous : { alias, cwd, token_hash: hash, ...refs, level, connected: false, last_heartbeat: 0 };
    row.level = level; this.#rows.set(alias, row); this.persist(row);
    return row;
  }
  authenticate(alias: string, token: string) { return validAlias(alias) && /^[a-f0-9]{64}$/.test(token) && this.get(alias)?.token_hash === payloadHash(token); }
  heartbeat(alias: string, now: number) {
    const row = this.get(alias)!; row.connected = true; row.last_heartbeat = now; this.persist(row);
  }
  disconnect(alias: string) {
    const row = this.get(alias)!;
    if (!row.connected) return false;
    row.connected = false; this.persist(row); return true;
  }
  expire(now: number) {
    return [...this.values()].filter(row => row.connected && now - row.last_heartbeat >= 6000 && this.disconnect(row.alias));
  }
  private persist(row: Session) {
    this.db.query(`INSERT OR REPLACE INTO sessions (alias, cwd, token_hash, workspace_ref, surface_ref, level, connected, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.alias, row.cwd, row.token_hash, row.workspace_ref, row.surface_ref, row.level, Number(row.connected), row.last_heartbeat);
  }
}
