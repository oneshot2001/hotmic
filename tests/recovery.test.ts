import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDB } from "../src/db";
import { RequestMachine, type RequestState } from "../src/requests";
import { replay } from "../scripts/replay";

const ref = { request_id: "request:d", revision: 1 };
const delivery = "delivery:request:d:1";
for (const boundary of ["WAITING_TRANSCRIPT", "WAITING_ROUTE", "READY", "DISPATCHING", "DELIVERED", "ACKNOWLEDGED", "WAITING_USER",
  "RESULT_LOCAL", "EXPORT_BLOCKED", "RESULT_AVAILABLE", "SPOKEN", "RECONCILE_REQUIRED", "FAILED", "CANCELLED"] as RequestState[]) {
  test(`restart at ${boundary} preserves durable state without auto-resend`, () => {
    const dir = mkdtempSync(join(tmpdir(), "hotmic-recovery-"));
    const path = join(dir, "state.sqlite"); let db = openDB(path);
    try {
      let m = new RequestMachine(db, () => boundary === "WAITING_ROUTE" ? "AMBIGUOUS" : "default");
      m.handle({ type: "delegation", id: "d", voice_epoch: "v", offset_ms: 0 }, 0);
      if (boundary !== "WAITING_TRANSCRIPT") m.handle({ type: "transcript", delegation_id: "d", text: "work" }, 1);
      if (!["WAITING_TRANSCRIPT", "WAITING_ROUTE", "READY", "FAILED", "CANCELLED"].includes(boundary)) m.handle({ type: "dispatch", ...ref }, 2);
      if (["DELIVERED", "ACKNOWLEDGED"].includes(boundary)) m.handle({ type: "delivered", delivery_id: delivery }, 3);
      if (boundary === "ACKNOWLEDGED") m.handle({ type: "acknowledge", delivery_id: delivery }, 4);
      if (["WAITING_USER", "RESULT_LOCAL", "EXPORT_BLOCKED", "RESULT_AVAILABLE", "SPOKEN"].includes(boundary))
        m.handle({ type: "reply", delivery_id: delivery, status: boundary === "WAITING_USER" ? "question" : "completed", text: "result" }, 5);
      if (boundary === "EXPORT_BLOCKED") m.handle({ type: "export_blocked", ...ref }, 6);
      if (["RESULT_AVAILABLE", "SPOKEN"].includes(boundary)) m.handle({ type: "export_result", ...ref }, 7);
      if (boundary === "SPOKEN") m.handle({ type: "spoken", ...ref }, 8);
      if (boundary === "FAILED") m.handle({ type: "fail", ...ref }, 8);
      if (boundary === "CANCELLED") m.handle({ type: "cancel", ...ref }, 8);
      if (boundary === "RECONCILE_REQUIRED") m.handle({ type: "tick" }, 60002);
      expect(m.snapshot().requests[0]?.state).toBe(boundary);
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      db.close(); db = openDB(path); m = new RequestMachine(db, undefined, 60003);
      expect(m.recoveryActions.some((a) => a.type === "deliver")).toBe(false);
      expect(m.snapshot().requests[0]?.state).toBe(boundary === "DISPATCHING" ? "RECONCILE_REQUIRED" : boundary);
      if (boundary === "DISPATCHING") {
        expect(m.recoveryActions).toMatchObject([{ type: "reconcile", delivery_id: delivery }]);
        expect(m.handle({ type: "dispatch", ...ref }, 11)).toEqual([]);
        db.close(); db = openDB(path); m = new RequestMachine(db, undefined, 12);
        expect(m.recoveryActions).toEqual([]);
      }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("correction transaction rolls back revision, old result invalidation and delivery together", () => {
  const db = openDB(); const m = new RequestMachine(db);
  try {
    m.handle({ type: "delegation", id: "d", voice_epoch: "v", offset_ms: 0 }, 0);
    m.handle({ type: "transcript", delegation_id: "d", text: "old" }, 1);
    m.handle({ type: "dispatch", ...ref }, 2);
    m.handle({ type: "reply", delivery_id: delivery, status: "completed", text: "old result" }, 3);
    m.handle({ type: "delegation", id: "d2", voice_epoch: "v", offset_ms: 4 }, 4);
    const before = m.snapshot();
    db.exec(`CREATE TRIGGER fail_revision BEFORE INSERT ON requests WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`);
    expect(() => m.handle({ type: "transcript", delegation_id: "d2", text: "Actually, change" }, 5)).toThrow("simulated disk failure");
    expect(m.snapshot()).toEqual(before);
    db.exec("DROP TRIGGER fail_revision");
    expect(m.handle({ type: "transcript", delegation_id: "d2", text: "Actually, change" }, 6)).toMatchObject([{ type: "deliver", revision: 2, supersedes: delivery }]);
  } finally { db.close(); }
});

test("synthetic correction survives restart with no stale export", async () => {
  const result = await replay("tests/fixtures/synthetic-correction.jsonl", { dup: true, reorder: true, crashAt: "SUPERSEDED" });
  expect(result.crashed).toBe(true);
  expect(result.requestCount).toBe(1);
  expect(result.table.map((r) => r.state)).toEqual(["SUPERSEDED", "SPOKEN"]);
  expect(result.actions.filter((a) => a.type === "append_result")).toMatchObject([{ revision: 2, text: "default: Current" }]);
  expect(result.state.results).toHaveLength(1);
});

test("synthetic replay duplicates replies and crashes at dispatch without rerun", async () => {
  const normal = await replay("tests/fixtures/synthetic-lifecycle.jsonl", { dup: true });
  expect(normal.table[0]?.state).toBe("SPOKEN");
  expect(normal.actions.filter((a) => a.type === "append_result")).toHaveLength(1);
  const crash = await replay("tests/fixtures/synthetic-lifecycle.jsonl", { crashAt: "DISPATCHING", dup: true });
  expect(crash.crashed).toBe(true);
  expect(crash.actions.filter((a) => a.type === "deliver")).toEqual([]);
  expect(crash.actions.filter((a) => a.type === "reconcile")).toHaveLength(1);
});
