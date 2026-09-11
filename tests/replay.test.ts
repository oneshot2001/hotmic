import { expect, spyOn, test } from "bun:test";
import { openDB } from "../src/db";
import { RequestMachine, type Action } from "../src/requests";
import { auditResultEmission, replay } from "../scripts/replay";

const ref = { request_id: "request:d", revision: 1 };
const append: Extract<Action, { type: "append_result" }> = { type: "append_result", ...ref, session_alias: "default", text: "result" };

test("replay audit checks persisted current revision, supersession at emission, and emitted identities", () => {
  const db = openDB(); const machine = new RequestMachine(db);
  const emitted = new Set<string>();
  try {
    expect(() => auditResultEmission(db, append, emitted)).toThrow("stale result emitted");
    machine.handle({ type: "delegation", id: "d", voice_epoch: "v", offset_ms: 0 }, 0);
    machine.handle({ type: "transcript", delegation_id: "d", text: "work" }, 1);
    machine.handle({ type: "dispatch", ...ref }, 2);
    machine.handle({ type: "reply", delivery_id: "delivery:request:d:1", status: "completed", text: "result" }, 3);
    const actions = machine.handle({ type: "export_result", ...ref }, 4);
    expect(actions).toEqual([{ ...append, text: "default: result" }]);
    auditResultEmission(db, append, emitted);
    expect(emitted.size).toBe(1);
    expect(() => auditResultEmission(db, append, emitted)).toThrow("result emitted more than once");
    db.query("UPDATE requests SET state = 'SUPERSEDED' WHERE id = ?").run(ref.request_id);
    expect(() => auditResultEmission(db, append, new Set())).toThrow("superseded result emitted");
    // A stale action can reference an extant historical revision.
    db.exec("INSERT INTO requests SELECT id, session_alias, 2, 'RESULT_AVAILABLE', text, created_at, updated_at, dispatched_at, acknowledged_at, stop_at, notices FROM requests");
    expect(() => auditResultEmission(db, append, new Set())).toThrow("stale result emitted");
    auditResultEmission(db, { ...append, revision: 2 }, emitted);
    expect(emitted.size).toBe(2);
  } finally { db.close(); }
});

test("replay audits every append action against SQLite even if the machine emits an invalid action", async () => {
  const original = RequestMachine.prototype.handle;
  const spy = spyOn(RequestMachine.prototype, "handle").mockImplementation(function (this: RequestMachine, event, now) {
    const actions = original.call(this, event, now);
    if (event.type === "export_result") {
      // Fault injection: a buggy reducer exports its current but superseded row.
      this.db.query("UPDATE requests SET state = 'SUPERSEDED' WHERE id = ? AND revision = ?").run(event.request_id, event.revision);
    }
    return actions;
  });
  try {
    await expect(replay("tests/fixtures/synthetic-lifecycle.jsonl")).rejects.toThrow("superseded result emitted");
  } finally { spy.mockRestore(); }
});
