import type { Database } from "bun:sqlite";
import { costUSD } from "./p0-audio";

export type Usage = { voice_epoch: string; seconds: number; usd: number; finalized: number;
  day: string; last_activity_at: number; close_requested: number };
export type Caps = { activation_usd: number; daily_usd: number; idle_ms: number };
export type LedgerEvent =
  | { type: "session.started" | "activity"; voice_epoch: string }
  | { type: "session.usage.updated"; voice_epoch: string; seconds: number }
  | { type: "session.closed"; voice_epoch: string; seconds?: number }
  | { type: "tick"; voice_epoch: string };
export type CloseAction = { type: "close"; voice_epoch: string; reason: "activation" | "daily" | "idle" };

export function ledgerStep(previous: Usage[], event: LedgerEvent, now: number, caps: Caps) {
  if (!event.voice_epoch || !Number.isFinite(now) || now < 0 ||
      !Object.values(caps).every((v) => Number.isFinite(v) && v > 0)) throw new Error("Invalid ledger input");
  const state = structuredClone(previous);
  const actions: CloseAction[] = [];
  const today = new Date(now).toISOString().slice(0, 10);
  let usage = state.find((v) => v.voice_epoch === event.voice_epoch);
  if (!usage) {
    if (event.type !== "session.started") throw new Error("Unknown voice epoch");
    usage = { voice_epoch: event.voice_epoch, seconds: 0, usd: 0, finalized: 0,
      day: today, last_activity_at: now, close_requested: 0 };
    state.push(usage);
  }
  // Snapshots do not locate individual seconds around midnight. Conservatively
  // charge the entire crossing epoch to the current UTC day, including close.
  if (!usage.finalized) usage.day = today;
  switch (event.type) {
    case "session.started": break; // Duplicate start cannot reset spend or idle time.
    case "activity": if (!usage.finalized) usage.last_activity_at = now; break;
    case "session.usage.updated":
    case "session.closed":
      if (!usage.finalized) {
        if (event.seconds !== undefined) { usage.usd = costUSD(event.seconds); usage.seconds = event.seconds; }
        else if (event.type !== "session.closed") throw new Error("Missing usage seconds");
        if (event.type === "session.closed") usage.finalized = 1;
      }
      break;
    case "tick": break;
    default: throw new Error("Unknown ledger event");
  }
  const daily = state.filter((u) => u.day === today).reduce((sum, u) => sum + u.usd, 0);
  const reason = usage.usd >= caps.activation_usd ? "activation" : daily >= caps.daily_usd ? "daily"
    : now - usage.last_activity_at >= caps.idle_ms ? "idle" : null;
  if (reason && !usage.finalized && !usage.close_requested) {
    usage.close_requested = 1;
    actions.push({ type: "close", voice_epoch: usage.voice_epoch, reason });
  }
  return { state, actions };
}

export class Ledger {
  constructor(readonly db: Database, readonly caps: Caps) {}
  snapshot(): Usage[] { return this.db.query<Usage, []>("SELECT * FROM usage").all(); }
  handle(event: LedgerEvent, now: number): CloseAction[] {
    return this.db.transaction(() => {
      const { state, actions } = ledgerStep(this.snapshot(), event, now, this.caps);
      for (const u of state) this.db.query(`INSERT INTO usage VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(voice_epoch) DO UPDATE SET seconds=excluded.seconds, usd=excluded.usd,
        finalized=excluded.finalized, day=excluded.day, last_activity_at=excluded.last_activity_at, close_requested=excluded.close_requested`)
        .run(u.voice_epoch, u.seconds, u.usd, u.finalized, u.day, u.last_activity_at, u.close_requested);
      return actions;
    })();
  }
}
