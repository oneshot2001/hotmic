import { expect, test } from "bun:test";
import { openDB } from "../src/db";
import { AMBIGUOUS, currentRequest, emptyRequests, parseRequestEvent, RequestMachine, requestStep, type RequestEvent } from "../src/requests";

export function ready(machine: RequestMachine, id = "d1", text = "Do the work", now = 0) {
  machine.handle({ type: "delegation", id, voice_epoch: "v", offset_ms: now }, now);
  return machine.handle({ type: "transcript", delegation_id: id, text }, now);
}
export const ref = { request_id: "request:d1", revision: 1 };
export const delivery = "delivery:request:d1:1";

test("pure reducer does not mutate input; delegation ids are durable no-ops", () => {
  const state = emptyRequests();
  const event = { type: "delegation", id: "d1", voice_epoch: "v", offset_ms: 0 } as const;
  const next = requestStep(state, event, 0);
  expect(state).toEqual(emptyRequests());
  expect(requestStep(next.state, event, 5)).toEqual({ state: next.state, actions: [] });
});

test("empty delegation waits at 2s, asks at 8s once and accepts text after 10s", () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    machine.handle({ type: "delegation", id: "d1", voice_epoch: "v", offset_ms: 0 }, 0);
    expect(machine.handle({ type: "tick" }, 1999)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 2000)).toMatchObject([{ type: "append_status", status: "waiting" }]);
    expect(machine.handle({ type: "tick" }, 7999)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 8000)).toMatchObject([{ type: "ask" }]);
    expect(machine.handle({ type: "tick" }, 10000)).toEqual([]);
    machine.handle({ type: "transcript", delegation_id: "d1", text: "Eventually" }, 10001);
    expect(currentRequest(machine.snapshot(), ref.request_id)?.state).toBe("READY");
  } finally { db.close(); }
});

for (const stage of ["READY", "DISPATCHING", "ACKNOWLEDGED", "RESULT_LOCAL", "EXPORT_BLOCKED"] as const) test(`correction at ${stage} atomically supersedes and blocks stale results`, () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine);
    if (stage !== "READY") machine.handle({ type: "dispatch", ...ref }, 1);
    if (["ACKNOWLEDGED", "RESULT_LOCAL", "EXPORT_BLOCKED"].includes(stage)) machine.handle({ type: "acknowledge", delivery_id: delivery }, 2);
    if (["RESULT_LOCAL", "EXPORT_BLOCKED"].includes(stage)) machine.handle({ type: "reply", delivery_id: delivery, status: "completed", text: "OLD CONTENT" }, 3);
    if (stage === "EXPORT_BLOCKED") machine.handle({ type: "export_blocked", ...ref }, 4);
    const actions = ready(machine, "d2", "Actually, do this instead", 10);
    const snapshot = machine.snapshot();
    expect(snapshot.requests.find((r) => r.id === ref.request_id && r.revision === 1)?.state).toBe("SUPERSEDED");
    expect(currentRequest(snapshot, ref.request_id)).toMatchObject({ revision: 2, text: "Actually, do this instead" });
    expect(snapshot.results).toEqual([]);
    expect(snapshot.delegations.find((d) => d.id === "d2")).toMatchObject({ request_id: ref.request_id, revision: 2 });
    if (stage === "READY") {
      expect(actions).toEqual([]);
      expect(snapshot.deliveries).toEqual([]);
    } else {
      expect(actions).toMatchObject([{ type: "deliver", revision: 2, supersedes: delivery }]);
      expect(snapshot.deliveries[0]?.state).toBe("SUPERSEDED");
    }
    expect(machine.handle({ type: "export_result", ...ref }, 11)).toEqual([]);
    expect(machine.handle({ type: "reply", delivery_id: delivery, status: "completed", text: "LATE OLD CONTENT" }, 12)).toEqual([]);
    expect(machine.handle({ type: "dispatch", ...ref }, 13)).toEqual([]);
    if (stage === "READY") machine.handle({ type: "dispatch", request_id: ref.request_id, revision: 2 }, 14);
    machine.handle({ type: "reply", delivery_id: "delivery:request:d1:2", status: "completed", text: "NEW CONTENT" }, 15);
    expect(machine.handle({ type: "export_result", request_id: ref.request_id, revision: 2 }, 16))
      .toEqual([{ type: "append_result", request_id: ref.request_id, revision: 2, session_alias: "default", text: "default: NEW CONTENT" }]);
  } finally { db.close(); }
});

for (const prefix of ["Actually,", "Instead,", "Replace that", "Cancel it", "Stop it", "Never mind that", "Actually\n", "Replace the last one", "Stop them"]) test(`${prefix} is a leading correction`, () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try { ready(machine); machine.handle({ type: "dispatch", ...ref }, 1);
    expect(ready(machine, "d2", `${prefix} change it`, 2)).toMatchObject([{ type: "deliver", revision: 2 }]);
  } finally { db.close(); }
});

test("routing ambiguity and unclassified active follow-ups are held; new task is fresh", () => {
  const db = openDB(); const machine = new RequestMachine(db, (text) => text === "unknown" ? AMBIGUOUS : "a");
  try {
    expect(ready(machine, "d1", "unknown")).toMatchObject([{ type: "ask", text: "Which session?" }]);
    expect(machine.handle({ type: "dispatch", ...ref }, 1)).toEqual([]);
    machine.handle({ type: "resolve_route", delegation_id: "d1", alias: "a", intent: "new" }, 2);
    machine.handle({ type: "dispatch", ...ref }, 3);
    expect(ready(machine, "d2", "Also add tests", 4)).toMatchObject([{ type: "ask" }]);
    expect(currentRequest(machine.snapshot(), "request:d2")?.state).toBe("WAITING_ROUTE");
    expect(ready(machine, "d3", "New task: actually start fresh", 5)).toEqual([]);
    expect(currentRequest(machine.snapshot(), "request:d3")).toMatchObject({ revision: 1, state: "READY" });
    machine.handle({ type: "resolve_route", delegation_id: "d2", alias: "a", intent: "correction" }, 6);
    expect(currentRequest(machine.snapshot(), "request:d1")?.revision).toBe(2);
    expect(currentRequest(machine.snapshot(), "request:d3")?.revision).toBe(1);
  } finally { db.close(); }
});

for (const status of ["completed", "failed", "question"] as const) test(`${status} reply is terminal, duplicates no-op, conflicting first wins`, () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine); machine.handle({ type: "dispatch", ...ref }, 1);
    const reply = { type: "reply", delivery_id: delivery, status, text: "First" } as const;
    expect(machine.handle(reply, 2)).toEqual([]); // Local text requires a separate export decision.
    expect(machine.handle(reply, 3)).toEqual([]);
    expect(machine.handle({ ...reply, text: "Conflicting" }, 4)).toMatchObject([{ type: "diagnostic" }]);
    expect(machine.snapshot().results).toHaveLength(1);
    expect(machine.snapshot().results[0]?.text).toBe("First");
    expect(currentRequest(machine.snapshot(), ref.request_id)?.state).toBe(status === "question" ? "WAITING_USER" : "RESULT_LOCAL");
    expect(machine.handle({ type: "export_result", ...ref }, 5)).toMatchObject([{ type: "append_result", ...ref }]);
    expect(machine.handle({ type: "export_result", ...ref }, 6)).toEqual([]);
    machine.handle({ type: "spoken", ...ref }, 7);
    expect(machine.handle(reply, 8)).toEqual([]);
    expect(machine.handle({ ...reply, status: status === "completed" ? "failed" : "completed" }, 9)).toMatchObject([{ type: "diagnostic" }]);
  } finally { db.close(); }
});

test("Stop without reply waits 3s and emits status once, never content", () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine); machine.handle({ type: "dispatch", ...ref }, 0);
    machine.handle({ type: "stop", delivery_id: delivery }, 100);
    machine.handle({ type: "stop", delivery_id: delivery }, 500);
    expect(machine.handle({ type: "tick" }, 3099)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 3100)).toEqual([{ type: "append_status", ...ref, status: "stopped", text: "default finished, result is in the terminal" }]);
    expect(machine.handle({ type: "tick" }, 5000)).toEqual([]);
    expect(machine.snapshot().results).toEqual([]);
  } finally { db.close(); }
});

test("reply during Stop grace suppresses fallback; timeout thresholds are once-only", () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine); machine.handle({ type: "dispatch", ...ref }, 0);
    expect(machine.handle({ type: "tick" }, 19999)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 20000)).toMatchObject([{ type: "append_status", status: "unconfirmed" }]);
    expect(machine.handle({ type: "tick" }, 59999)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 60000)).toMatchObject([{ type: "reconcile" }]);
    expect(machine.handle({ type: "tick" }, 119999)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 120000)).toMatchObject([{ type: "append_status", status: "still_working" }]);
    expect(machine.handle({ type: "tick" }, 150000)).toEqual([]);
    machine.handle({ type: "stop", delivery_id: delivery }, 150000);
    machine.handle({ type: "reply", delivery_id: delivery, status: "completed", text: "done" }, 151000);
    expect(machine.handle({ type: "tick" }, 153000)).toEqual([]);
  } finally { db.close(); }
});

test("ack before delivered never regresses state and suppresses no-ack timers", () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine); machine.handle({ type: "dispatch", ...ref }, 0);
    machine.handle({ type: "acknowledge", delivery_id: delivery }, 1);
    machine.handle({ type: "delivered", delivery_id: delivery }, 2);
    expect(currentRequest(machine.snapshot(), ref.request_id)?.state).toBe("ACKNOWLEDGED");
    expect(machine.handle({ type: "tick" }, 60000)).toEqual([]);
    expect(machine.handle({ type: "tick" }, 120000)).toMatchObject([{ status: "still_working" }]);
  } finally { db.close(); }
});

test("unknown operations fail closed", () => {
  expect(() => requestStep(emptyRequests(), { type: "delete_everything" } as unknown as RequestEvent, 0)).toThrow();
  for (const bad of [null, { type: "delete_everything", ...ref }, { type: "reply", delivery_id: delivery, status: ["completed"], text: "bad" },
    { type: "dispatch", request_id: "r", revision: "1" }, { type: "dispatch", request_id: "r", revision: 0 }]) {
    expect(() => parseRequestEvent(bad)).toThrow();
  }
});

for (const text of ["Replace the database driver", "Stop the server", "Cancel scheduled jobs", "Actually run tests", "Instead run tests", "Never mind the warnings"]) test(`ordinary sentence asks instead of auto-sending: ${text}`, () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine); machine.handle({ type: "dispatch", ...ref }, 1);
    machine.handle({ type: "delivered", delivery_id: delivery }, 2);
    expect(ready(machine, "d2", text, 3)).toMatchObject([{ type: "ask" }]);
    expect(currentRequest(machine.snapshot(), ref.request_id)).toMatchObject({ revision: 1, state: "DELIVERED" });
    expect(currentRequest(machine.snapshot(), "request:d2")?.state).toBe("WAITING_ROUTE");
    expect(machine.snapshot().deliveries).toHaveLength(1);
  } finally { db.close(); }
});

for (const stage of ["DISPATCHING", "DELIVERED", "ACKNOWLEDGED", "WAITING_USER", "RESULT_LOCAL", "EXPORT_BLOCKED"] as const) test(`correction prioritizes ${stage} over a newer READY request`, () => {
  const db = openDB(); const machine = new RequestMachine(db);
  try {
    ready(machine, "d1", "Run tests"); machine.handle({ type: "dispatch", ...ref }, 1);
    if (stage === "DELIVERED") machine.handle({ type: "delivered", delivery_id: delivery }, 2);
    if (stage === "ACKNOWLEDGED") machine.handle({ type: "acknowledge", delivery_id: delivery }, 2);
    if (["WAITING_USER", "RESULT_LOCAL", "EXPORT_BLOCKED"].includes(stage)) machine.handle({ type: "reply", delivery_id: delivery, status: stage === "WAITING_USER" ? "question" : "completed", text: "old" }, 2);
    if (stage === "EXPORT_BLOCKED") machine.handle({ type: "export_blocked", ...ref }, 3);
    ready(machine, "d2", "New task: write docs", 4);
    expect(ready(machine, "d3", "Actually, run only unit tests", 5)).toMatchObject([{ type: "deliver", request_id: ref.request_id, revision: 2, supersedes: delivery }]);
    expect(currentRequest(machine.snapshot(), "request:d2")).toMatchObject({ revision: 1, state: "READY", text: "New task: write docs" });
  } finally { db.close(); }
});

for (const stage of ["RECONCILE_REQUIRED", "RESULT_AVAILABLE", "SPOKEN"] as const) {
  for (const queued of [false, true]) test(`correction at ${stage} asks even with queued=${queued}`, () => {
    const db = openDB(); const machine = new RequestMachine(db);
    try {
      ready(machine); machine.handle({ type: "dispatch", ...ref }, 1);
      if (stage === "RECONCILE_REQUIRED") machine.handle({ type: "recover" }, 2);
      else {
        machine.handle({ type: "reply", delivery_id: delivery, status: "completed", text: "result" }, 2);
        machine.handle({ type: "export_result", ...ref }, 3);
        if (stage === "SPOKEN") machine.handle({ type: "spoken", ...ref }, 4);
      }
      if (queued) ready(machine, "queued", "New task: write docs", 5);
      expect(ready(machine, "d2", "Actually, run only unit tests", 6)).toMatchObject([{ type: "ask" }]);
      expect(currentRequest(machine.snapshot(), ref.request_id)).toMatchObject({ revision: 1, state: stage });
      expect(machine.snapshot().deliveries).toHaveLength(1);
    } finally { db.close(); }
  });
}
