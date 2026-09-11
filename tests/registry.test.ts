import { test, expect } from "bun:test";
import { openDB } from "../src/db";
import { Registry } from "../src/registry";
import { payloadHash } from "../src/egress";
import { startHeartbeat } from "../shim/channel";
test("registry migration is idempotent, persists hashes and refs, restores disconnected", () => {
  const db = openDB();
  try {
    db.exec("CREATE TABLE sessions (alias TEXT PRIMARY KEY, cwd TEXT NOT NULL, token_hash TEXT NOT NULL)");
    db.query("INSERT INTO sessions VALUES (?, ?, ?)").run("legacy", "/tmp", payloadHash("a".repeat(64)));
    const r = new Registry(db);
    expect(r.get("legacy")?.level).toBe("off");
    r.register("new", "/tmp", "b".repeat(64), "release", { workspace_ref: "workspace:88", surface_ref: "surface:12" });
    r.heartbeat("new", 42);
    const row = db.query("SELECT * FROM sessions WHERE alias = 'new'").get();
    expect(row).toMatchObject({ token_hash: payloadHash("b".repeat(64)), connected: 1, last_heartbeat: 42, surface_ref: "surface:12" });
    expect(JSON.stringify(row)).not.toContain("b".repeat(64));
    let restarted!: Registry;
    expect(() => { restarted = new Registry(db); }).not.toThrow();
    expect(restarted.get("new")).toMatchObject({ connected: false, workspace_ref: "workspace:88", level: "release" });
    expect(restarted.authenticate("new", "b".repeat(64))).toBe(true);
    expect(new Registry(db).size).toBe(2);
  } finally { db.close(); }
});
test("registry heartbeat expires at six seconds once and restores with the same token", () => {
  const db = openDB(), r = new Registry(db);
  try {
    r.register("one", "/tmp", "a".repeat(64), "release"); r.heartbeat("one", 1000);
    expect(r.expire(6999)).toEqual([]); expect(r.get("one")?.connected).toBe(true);
    expect(r.expire(7000).map(s => s.alias)).toEqual(["one"]);
    expect(r.expire(8000)).toEqual([]); expect(r.get("one")?.connected).toBe(false);
    r.register("one", "/tmp", "a".repeat(64), "release"); r.heartbeat("one", 8000);
    expect(r.get("one")?.connected).toBe(true);
  } finally { db.close(); }
});
test("registry rejects different tokens, changed identity, malformed refs and session nine", () => {
  const db = openDB(), r = new Registry(db);
  try {
    for (let i = 0; i < 8; i++) r.register(`s${i}`, "/tmp", "a".repeat(64), "status");
    expect(() => r.register("s8", "/tmp", "a".repeat(64), "status")).toThrow("Maximum 8");
    r.heartbeat("s0", 1000);
    expect(() => r.register("s0", "/tmp", "b".repeat(64), "status")).toThrow("different token");
    expect(() => r.register("s0", "/changed", "a".repeat(64), "status")).toThrow("identity changed");
    expect(() => r.register("s0", "/tmp", "bad", "status")).toThrow();
    expect(() => r.register("s0", "/tmp", "a".repeat(64), "status", { surface_ref: 12 as any, workspace_ref: null })).toThrow();
    expect(r.authenticate("s0", "bad")).toBe(false);
    expect(r.authenticate("s0", "b".repeat(64))).toBe(false);
    expect(r.authenticate("missing", "a".repeat(64))).toBe(false);
  } finally { db.close(); }
});
test("registry relaunch rotates disconnected capability and refs, persists replacement without old transport", () => {
  const db = openDB(), r = new Registry(db);
  try {
    const old = r.register("one", "/tmp/old", "a".repeat(64), "status", { workspace_ref: "old", surface_ref: "old" });
    old.send = () => {}; old.ready = true; r.heartbeat("one", 1000);
    expect(() => r.register("one", "/tmp/new", "b".repeat(64), "release")).toThrow("different token");
    r.disconnect("one");
    const refs = { workspace_ref: "new", surface_ref: "new" };
    let replacement!: ReturnType<Registry["register"]>;
    expect(() => { replacement = r.register("one", "/tmp/new", "b".repeat(64), "release", refs); }).not.toThrow();
    expect(replacement).not.toBe(old);
    expect(replacement).toMatchObject({ ...refs, cwd: "/tmp/new", level: "release", connected: false, last_heartbeat: 0 });
    expect(replacement.send).toBeUndefined(); expect(replacement.ready).toBeUndefined();
    expect(r.authenticate("one", "a".repeat(64))).toBe(false);
    expect(r.authenticate("one", "b".repeat(64))).toBe(true);
    const restarted = new Registry(db);
    expect(restarted.authenticate("one", "b".repeat(64))).toBe(true);
    expect(restarted.get("one")).toMatchObject(refs);
    expect(() => restarted.register("one", "/tmp/new", "c".repeat(64), "release", refs)).not.toThrow();
  } finally { db.close(); }
});
test("shim sends the exact heartbeat line every two seconds and stops on cleanup", async () => {
  const lines: string[] = [], stop = startHeartbeat(line => lines.push(line));
  try {
    await Bun.sleep(2050); expect(lines).toEqual(['{"type":"heartbeat"}\n']);
    stop(); await Bun.sleep(2050); expect(lines).toHaveLength(1);
  } finally { stop(); }
}, 5000);
test("registry validates input before storing any new row", () => {
  const db = openDB(), r = new Registry(db);
  try {
    for (const [alias, token, refs] of [["bad alias", "a".repeat(64), { workspace_ref: null, surface_ref: null }],
      ["valid", "bad", { workspace_ref: null, surface_ref: null }],
      ["valid", "a".repeat(64), { workspace_ref: null, surface_ref: 123 }]] as const) {
      expect(() => r.register(alias, "/tmp", token, "status", refs as any)).toThrow("Invalid registration");
    }
    expect(r.size).toBe(0);
  } finally { db.close(); }
});
test("registry expiry retains persisted queued and in-flight requests", () => {
  const db = openDB(), r = new Registry(db);
  try {
    r.register("one", "/tmp", "a".repeat(64), "release"); r.heartbeat("one", 1000);
    db.query("INSERT INTO requests (id, session_alias, revision, state, text, created_at, updated_at, notices) VALUES (?, ?, 1, ?, 'retained', 0, 0, 0)").run("queued", "one", "READY");
    db.query("INSERT INTO requests (id, session_alias, revision, state, text, created_at, updated_at, notices) VALUES (?, ?, 1, ?, 'retained', 0, 0, 0)").run("active", "one", "DELIVERED");
    const before = db.query("SELECT * FROM requests").all();
    r.expire(7000); expect(db.query("SELECT * FROM requests").all()).toEqual(before);
    r.heartbeat("one", 8000); expect(db.query("SELECT * FROM requests").all()).toEqual(before);
  } finally { db.close(); }
});
