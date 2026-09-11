import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDB } from "../src/db";
import { Ledger } from "../src/ledger";
import { parseRequestEvent, RequestMachine, REQUEST_STATES, type Action, type RequestEvent, type RequestState } from "../src/requests";
import { emptyTranscripts, transcriptStep, type TranscriptDiagnostic, type TranscriptEvent } from "../src/transcripts";
import { object } from "../shim/protocol";

type Row = { at: number; event: Record<string, unknown> };
export type ReplayOptions = { delayMs?: number; dup?: boolean; reorder?: boolean; crashAt?: RequestState };
function invariant(value: unknown, message: string): asserts value { if (!value) throw new Error(`Invariant: ${message}`); }
const number = (v: unknown): number => { invariant(typeof v === "number" && Number.isFinite(v) && v >= 0, "invalid number"); return v; };
const string = (v: unknown): string => { invariant(typeof v === "string" && v.length > 0, "invalid string"); return v; };

export function auditResultEmission(db: Database, action: Extract<Action, { type: "append_result" }>, emitted: Set<string>) {
  const current = db.query("SELECT revision, state FROM requests WHERE id = ? ORDER BY revision DESC LIMIT 1")
    .get(action.request_id) as { revision: number; state: string } | null;
  invariant(current?.revision === action.revision, "stale result emitted");
  // Check the persisted revision at emission time, not just the reducer's ref.
  invariant(current.state !== "SUPERSEDED", "superseded result emitted");
  const key = JSON.stringify([action.request_id, action.revision]);
  invariant(!emitted.has(key), "result emitted more than once");
  emitted.add(key);
}

export async function replay(path: string, options: ReplayOptions = {}) {
  if (options.delayMs !== undefined) number(options.delayMs);
  if (options.crashAt) invariant(REQUEST_STATES.includes(options.crashAt), "unknown crash state");
  let rows: Row[] = (await Bun.file(path).text()).split("\n").filter((line) => line.trim()).map((line) => {
    const row: unknown = JSON.parse(line);
    invariant(object(row) && object(row.event), "invalid fixture row");
    return { at: number(row.at), event: row.event };
  });
  const original = structuredClone(rows);
  const delegations = original.filter((r) => r.event.type === "session.delegation.created").sort((a, b) => number(a.event.offset_ms) - number(b.event.offset_ms));
  const expectations = original.filter((r) => r.event.type === "replay.expect");
  if (options.delayMs !== undefined) {
    rows = rows.map((row) => {
      if (row.event.type !== "session.input_transcript.delta") return row;
      const owner = delegations.find((d) => number(row.event.start_ms) <= number(d.event.offset_ms));
      // Hold each utterance's fragments until N ms after its delegation. This
      // changes arrival only: source ranges, offsets and local silence survive.
      return owner ? { ...row, at: Math.max(row.at, owner.at + options.delayMs!) } : row;
    });
  }
  rows.sort((a, b) => a.at - b.at);
  if (options.dup) rows = rows.flatMap((r) => r.event.type === "session.delegation.created" ||
    (r.event.type === "replay.request" && object(r.event.command) && r.event.command.type === "reply") ? [r, structuredClone(r)] : [r]);
  // Reorder adjacent arrivals within the settle window. Moving a word across
  // an already committed boundary can make it a straggler; distant old ranges
  // are quarantined (covered separately in transcripts.test.ts).
  if (options.reorder) for (let i = 0; i + 1 < rows.length; i += 2) {
    if (rows[i + 1]!.at - rows[i]!.at < 250) [rows[i], rows[i + 1]] = [rows[i + 1]!, rows[i]!];
  }

  const dir = mkdtempSync(join(tmpdir(), "hotmic-replay-"));
  const dbPath = join(dir, "replay.sqlite");
  let db = openDB(dbPath);
  let machine = new RequestMachine(db);
  const caps = { activation_usd: 0.5, daily_usd: 3, idle_ms: 180000 };
  let ledger = new Ledger(db, caps);
  let transcripts = emptyTranscripts(), now = 0, crashed = false, started = false;
  const epoch = "replay";
  const actions: (Action & { at: number })[] = [];
  const delivered = new Set<string>();
  const emittedResults = new Set<string>();
  const audit = (emitted: Action[]) => {
    const state = machine.snapshot();
    for (const action of emitted) {
      if (action.type === "deliver") {
        invariant(!delivered.has(action.delivery_id), "delivery emitted more than once");
        invariant(state.deliveries.some((d) => d.id === action.delivery_id && d.state === "DISPATCHING"), "delivery emitted before durable dispatch");
        delivered.add(action.delivery_id);
      }
      if (action.type === "append_result") auditResultEmission(db, action, emittedResults);
      actions.push({ ...action, at: now });
    }
  };
  const handle = (event: RequestEvent) => {
    const emitted = machine.handle(event, now);
    if (!crashed && options.crashAt && machine.snapshot().requests.some((r) => r.state === options.crashAt)) {
      crashed = true;
      // Kill after commit and before consuming actions. The fixture driver is
      // the input journal; only the durable request/usage owner is restarted.
      db.close(); db = openDB(dbPath); machine = new RequestMachine(db, undefined, now); ledger = new Ledger(db, caps);
      invariant(machine.recoveryActions.every((a) => a.type !== "deliver"), "restart auto-resends");
      if (options.crashAt === "DISPATCHING") invariant(machine.snapshot().requests.some((r) => r.state === "RECONCILE_REQUIRED"), "dispatch not reconciled after crash");
      audit(machine.recoveryActions);
    } else audit(emitted);
  };
  const diagnostics: (TranscriptDiagnostic & { at: number })[] = [];
  const feed = (event: TranscriptEvent) => {
    const next = transcriptStep(transcripts, event, now); transcripts = next.state;
    diagnostics.push(...next.diagnostics.map((diagnostic) => ({ ...diagnostic, at: now })));
    for (const ready of next.ready) handle({ type: "transcript", delegation_id: ready.id, text: ready.text });
  };
  const tick = () => {
    feed({ type: "tick" }); handle({ type: "tick" });
    if (started) ledger.handle({ type: "tick", voice_epoch: epoch }, now);
  };
  try {
    for (const row of rows) {
      while (now + 250 < row.at) { now += 250; tick(); }
      now = Math.max(now, row.at);
      const e = row.event;
      switch (e.type) {
        case "session.started": ledger.handle({ type: "session.started", voice_epoch: epoch }, now); started = true; break;
        case "local.silence":
          invariant(typeof e.silent === "boolean", "invalid silence flag");
          feed({ type: "silence", at_ms: number(e.at_ms), silent: e.silent }); break;
        case "session.input_transcript.delta":
          feed({ type: "fragment", fragment: { start_ms: number(e.start_ms), end_ms: number(e.end_ms), delta: string(e.delta) } }); break;
        case "session.delegation.created": {
          invariant(object(e.delegation), "invalid delegation");
          const id = string(e.delegation.id), offset_ms = number(e.offset_ms);
          handle({ type: "delegation", id, offset_ms, voice_epoch: epoch });
          feed({ type: "delegation", id, offset_ms }); break;
        }
        case "session.usage.updated":
        case "session.closed":
          invariant(object(e.usage), "missing usage");
          ledger.handle({ type: e.type, voice_epoch: epoch, seconds: number(e.usage.seconds) }, now); break;
        case "replay.request":
          invariant(object(e.command) && typeof e.command.type === "string", "invalid request command");
          handle(parseRequestEvent(e.command)); break;
        case "replay.expect": break;
        default: throw new Error(`Unknown fixture event: ${String(e.type)}`);
      }
    }
    now += 1000; tick();
    const state = machine.snapshot();
    const ids = new Set(delegations.map((r) => { invariant(object(r.event.delegation), "bad delegation"); return string(r.event.delegation.id); }));
    invariant(state.delegations.length === ids.size && state.delegations.every((d) => ids.has(d.id)), "lost or duplicate delegation");
    invariant(state.delegations.every((d) => d.request_id && state.requests.some((r) => r.id === d.request_id && r.revision === d.revision)), "orphan delegation");
    invariant(state.requests.filter((r) => r.state === "SUPERSEDED").every((r) => !state.results.some((v) => v.request_id === r.id && v.revision === r.revision)), "superseded result retained");
    const consumed = transcripts.delegations.flatMap((d) => d.assembly?.range.sequences ?? []);
    invariant(new Set(consumed).size === consumed.length, "fragment reused");
    if (options.crashAt) invariant(crashed, `crash boundary ${options.crashAt} was not reached`);
    for (const row of expectations) {
      invariant(Array.isArray(row.event.requests), "missing expected texts");
      invariant(row.event.requests.length === state.delegations.length, "wrong delegation count");
      for (const expected of row.event.requests) {
        invariant(object(expected), "invalid expected request");
        const d = state.delegations.find((d) => d.id === expected.delegation_id);
        const request = state.requests.find((r) => r.id === d?.request_id && r.revision === d?.revision);
        invariant(request && request.text === expected.text, `text mismatch for ${String(expected.delegation_id)}: ${JSON.stringify(request?.text)}`);
        invariant(request.state !== "WAITING_TRANSCRIPT" && request.state !== "WAITING_ROUTE", "request not ready");
      }
      if (row.event.seconds !== undefined) {
        const usage = ledger.snapshot()[0];
        invariant(usage?.seconds === row.event.seconds && usage.finalized === 1, "final usage mismatch");
        invariant(Math.abs(usage.usd - number(row.event.seconds) / 1200) < 1e-12, "cost mismatch");
      }
    }
    const table = state.delegations.map((d) => {
      const r = state.requests.find((r) => r.id === d.request_id && r.revision === d.revision)!;
      return { delegation: d.id, request: r.id, revision: r.revision, state: r.state, text: r.text };
    });
    return { table, actions, diagnostics, state, usage: ledger.snapshot(), requestCount: new Set(state.requests.map((r) => r.id)).size, crashed };
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options: {
      "delay-ms": { type: "string" }, dup: { type: "boolean" }, reorder: { type: "boolean" }, "crash-at": { type: "string" },
    } });
    invariant(positionals.length === 1, "usage: bun scripts/replay.ts fixture.jsonl [--delay-ms N] [--dup] [--reorder] [--crash-at STATE]");
    const result = await replay(positionals[0]!, { delayMs: values["delay-ms"] === undefined ? undefined : Number(values["delay-ms"]),
      dup: values.dup, reorder: values.reorder, crashAt: values["crash-at"] as RequestState | undefined });
    console.table(result.table);
    for (const diagnostic of result.diagnostics) console.error(`Diagnostic: ${JSON.stringify(diagnostic)}`);
    console.log(`PASS: ${result.requestCount} requests, ${result.table.length} delegations; invariants satisfied.`);
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
