import { test, expect, spyOn } from "bun:test";
import { gradeMulti, multiSteps } from "../scripts/smoke-multi";
import { emptyRequests } from "../src/requests";
import { MIN_ACTIVATION_USD } from "../src/ledger";
import { main } from "../scripts/smoke";
import * as multiRunner from "../scripts/smoke-multi";
test("multi smoke rejects the minimum activation budget before running the scenario", async () => {
  const argv = process.argv;
  const run = spyOn(multiRunner, "smokeMulti").mockRejectedValue(new Error("Unexpected scenario execution"));
  process.argv = [process.execPath, "smoke.ts", "--grade", "--scenario", "multi", "--max-usd", String(MIN_ACTIVATION_USD)];
  try {
    await expect(main()).rejects.toThrow("Human-run only");
    expect(run).not.toHaveBeenCalled();
  } finally { process.argv = argv; run.mockRestore(); }
});
function fixture() {
  const store = emptyRequests(), events: Record<string, any>[] = [];
  multiSteps.forEach((s, i) => {
    const request_id = `r${i}`, revision = 1;
    store.requests.push({ id: request_id, session_alias: s.alias, revision, state: "RESULT_AVAILABLE", text: s.say, created_at: i, updated_at: i, dispatched_at: i, acknowledged_at: i, stop_at: null, notices: 0 });
    store.deliveries.push({ id: `d${i}`, request_id, revision, delegation_id: `dg${i}`, state: "RESULT_AVAILABLE", created_at: i, supersedes: null });
    if (i === 6 || i === 8) events.push({ type: "ask", request_id }, { type: "net control", operation: "resolve", request_id });
    for (const type of ["delivered", "acknowledged", "replied"]) events.push({ type, request_id, revision, session_alias: s.alias });
    events.push({ type: "outbound", source: "reply", request_id, revision, session_alias: s.alias, frame: { content: `${s.alias}: done` } });
  });
  events.push({ type: "output_transcript" });
  return { store, events, usage: [{ usd: 0.10, finalized: 1 }, { usd: 0.15, finalized: 1 }] };
}
test("multi smoke grades ten destinations, resolved asks, prefixed payloads and total finalized cost", () => {
  const f = fixture();
  expect(Object.values(gradeMulti(f.events, f.store, f.usage, 0.30, true).checks).every(Boolean)).toBe(true);
  expect(gradeMulti(f.events, f.store, f.usage, 0.30, true).cost_usd).toBe(0.25);
});
test("multi smoke fails wrong destinations, unresolved dispatch, off delivery, missing or wrong prefix and unfinalized over-cap usage", () => {
  const f = fixture(), grade = () => gradeMulti(f.events, f.store, f.usage, 0.30, true).checks;
  f.events.find(e => e.type === "delivered")!.session_alias = "bravo";
  expect(grade().ten_correct_destinations).toBe(false);
  f.events = f.events.filter(e => e.operation !== "resolve"); expect(grade().ambiguous_never_dispatched).toBe(false);
  f.store.requests[0]!.session_alias = "off"; expect(grade().off_unregistered_never_delivered).toBe(false);
  f.events.find(e => e.source === "reply")!.frame.content = "wrong: done"; expect(grade().every_result_prefixed).toBe(false);
  f.usage[0]!.finalized = 0; expect(grade().finalized).toBe(false);
  f.usage[1]!.usd = 0.25; expect(grade().within_cap).toBe(false);
  expect(gradeMulti(f.events, f.store, [], 0.30, true).checks.finalized).toBe(false);
  expect(gradeMulti(f.events, f.store, [], 0.30, true).checks.within_cap).toBe(false);
  expect(gradeMulti(f.events, f.store, f.usage, 0.30, false).checks.audible_prefixes_confirmed).toBe(false);
});
test("multi smoke does not pass partial, unacknowledged, or interleaved results", () => {
  const f = fixture();
  const short = f.events.filter(e => e.request_id !== "r9");
  expect(gradeMulti(short, f.store, f.usage, 0.30, true).checks.ten_correct_destinations).toBe(false);
  expect(gradeMulti(short, f.store, f.usage, 0.30, true).checks.every_result_prefixed).toBe(false);
  expect(gradeMulti(f.events.filter(e => e.type !== "acknowledged"), f.store, f.usage, 0.30, true).checks.ten_acknowledged_replied).toBe(false);
  f.events.push({ ...f.events.find(e => e.source === "reply")!, frame: { content: "extra" } });
  expect(gradeMulti(f.events, f.store, f.usage, 0.30, true).checks.every_result_prefixed).toBe(false);
});
test("multi smoke verifies prefix independently of ownership and requires resolution before delivery", () => {
  const f = fixture();
  f.events.find(e => e.source === "reply")!.frame.content = "wrong: done";
  expect(gradeMulti(f.events, f.store, f.usage, 0.30, true).checks.every_result_prefixed).toBe(false);
  const g = fixture(), resolution = g.events.find(e => e.operation === "resolve")!;
  g.events.splice(g.events.indexOf(resolution), 1); g.events.push(resolution);
  expect(gradeMulti(g.events, g.store, g.usage, 0.30, true).checks.ambiguous_never_dispatched).toBe(false);
});
