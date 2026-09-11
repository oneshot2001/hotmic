import type { Database } from "bun:sqlite";

export const REQUEST_STATES = ["WAITING_TRANSCRIPT", "WAITING_ROUTE", "READY", "DISPATCHING", "DELIVERED",
  "ACKNOWLEDGED", "WAITING_USER", "RESULT_LOCAL", "EXPORT_BLOCKED", "RESULT_AVAILABLE", "SPOKEN",
  "SUPERSEDED", "RECONCILE_REQUIRED", "FAILED", "CANCELLED"] as const;
export type RequestState = typeof REQUEST_STATES[number];
export type Request = {
  id: string; session_alias: string; revision: number; state: RequestState; text: string;
  created_at: number; updated_at: number; dispatched_at: number | null; acknowledged_at: number | null;
  stop_at: number | null; notices: number;
};
export type Delivery = { id: string; request_id: string; revision: number; delegation_id: string;
  state: RequestState; created_at: number; supersedes: string | null };
export type Result = { request_id: string; revision: number; status: "completed" | "failed" | "question";
  text: string; source: "reply"; created_at: number };
export type Delegation = { id: string; voice_epoch: string; offset_ms: number; state: RequestState;
  request_id: string | null; revision: number | null; created_at: number };
export type RequestStore = { requests: Request[]; deliveries: Delivery[]; results: Result[]; delegations: Delegation[] };
export const emptyRequests = (): RequestStore => ({ requests: [], deliveries: [], results: [], delegations: [] });
export const AMBIGUOUS = "AMBIGUOUS" as const;
export type Route = (text: string) => string | { alias: string; text: string };
type Reference = { request_id: string; revision: number };
export type RequestEvent =
  | { type: "delegation"; id: string; voice_epoch: string; offset_ms: number }
  | { type: "transcript"; delegation_id: string; text: string }
  | { type: "resolve_route"; delegation_id: string; alias: string; intent: "new" | "correction" | "route" }
  | ({ type: "dispatch" | "export_blocked" | "export_result" | "spoken" | "cancel" | "fail" } & Reference)
  | { type: "delivered" | "acknowledge" | "stop"; delivery_id: string }
  | { type: "reply"; delivery_id: string; status: Result["status"]; text: string }
  | { type: "tick" | "recover" };
export type Action =
  | ({ type: "deliver"; delivery_id: string; delegation_id: string; session_alias: string; text: string; supersedes?: string } & Reference)
  | ({ type: "append_result"; session_alias: string; text: string } & Reference)
  | ({ type: "append_status"; status: "waiting" | "unconfirmed" | "still_working" | "stopped"; text: string } & Reference)
  | ({ type: "ask"; text: string } & Reference)
  | ({ type: "reconcile"; delivery_id: string } & Reference)
  | { type: "diagnostic"; delivery_id: string; text: string };

export function currentRequest(state: RequestStore, id: string) {
  return state.requests.filter((r) => r.id === id).sort((a, b) => b.revision - a.revision)[0];
}
const deliveryStates: RequestState[] = ["DISPATCHING", "DELIVERED", "ACKNOWLEDGED", "WAITING_USER", "RESULT_LOCAL", "EXPORT_BLOCKED", "RESULT_AVAILABLE", "RECONCILE_REQUIRED"];
// Export-blocked results are still local. Exported and uncertain deliveries
// require clarification; they are never automatic correction targets.
const correctionStates: RequestState[] = ["DISPATCHING", "DELIVERED", "ACKNOWLEDGED", "WAITING_USER", "RESULT_LOCAL", "EXPORT_BLOCKED"];
const correction = /^(?:(?:actually|instead)(?:\s*,|[ \t]*(?:\n|\r|…|\.\.\.|—))|(?:actually|instead|replace|cancel|stop|never\s+mind)\s+(?:that|it|this|these|those|them|the\s+last\s+one)\b)/i;
const newTask = /^new\s+task\b/i;
const WAITING = 1, ASKED = 2, UNCONFIRMED = 4, RECONCILED = 8, STILL_WORKING = 16, STOPPED = 32;

export function parseRequestEvent(value: unknown): RequestEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid request event");
  const e = value as Record<string, unknown>;
  const strings = (...keys: string[]) => keys.every((key) => typeof e[key] === "string" && (e[key] as string).trim().length > 0);
  const reference = () => strings("request_id") && typeof e.revision === "number" && Number.isSafeInteger(e.revision) && e.revision > 0;
  let valid: boolean;
  switch (e.type) {
    case "delegation": valid = strings("id", "voice_epoch") && typeof e.offset_ms === "number" && Number.isFinite(e.offset_ms) && e.offset_ms >= 0; break;
    case "transcript": valid = strings("delegation_id") && typeof e.text === "string"; break;
    case "resolve_route": valid = strings("delegation_id", "alias") && (e.intent === "new" || e.intent === "correction" || e.intent === "route"); break;
    case "dispatch": case "export_blocked": case "export_result": case "spoken": case "cancel": case "fail": valid = reference(); break;
    case "delivered": case "acknowledge": case "stop": valid = strings("delivery_id"); break;
    case "reply": valid = strings("delivery_id") && typeof e.status === "string" && ["completed", "failed", "question"].includes(e.status) && typeof e.text === "string"; break;
    case "tick": case "recover": valid = true; break;
    default: throw new Error("Unknown request event");
  }
  if (!valid) throw new Error("Invalid request event");
  return value as RequestEvent;
}

// Deterministic event-in/action-out. SQLite and transport do not exist here.
export function requestStep(previous: RequestStore, event: RequestEvent, now: number, route: Route = () => "default", canDispatch: (alias: string) => boolean = () => true) {
  parseRequestEvent(event);
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid clock");
  const state = structuredClone(previous);
  const actions: Action[] = [];
  const ref = (r: Request): Reference => ({ request_id: r.id, revision: r.revision });
  const deliveryFor = (r: Request) => state.deliveries.find((d) => d.request_id === r.id && d.revision === r.revision);
  const setState = (r: Request, next: RequestState) => {
    r.state = next; r.updated_at = now;
    const delivery = deliveryFor(r);
    if (delivery) delivery.state = next;
    for (const d of state.delegations) if (d.request_id === r.id && d.revision === r.revision) d.state = next;
  };
  const dispatch = (r: Request, delegation: Delegation, supersedes?: string) => {
    if (r.state !== "READY" || deliveryFor(r) || !canDispatch(r.session_alias)) return;
    const id = `delivery:${r.id}:${r.revision}`;
    state.deliveries.push({ id, ...ref(r), delegation_id: delegation.id, state: "DISPATCHING", created_at: now, supersedes: supersedes ?? null });
    r.dispatched_at = now; setState(r, "DISPATCHING");
    actions.push({ type: "deliver", ...ref(r), delivery_id: id, delegation_id: delegation.id,
      session_alias: r.session_alias, text: r.text, ...(supersedes ? { supersedes } : {}) });
  };
  const assign = (d: Delegation, r: Request, alias: string, intent?: "new" | "correction") => {
    if (!alias.trim() || alias === AMBIGUOUS) {
      setState(r, "WAITING_ROUTE");
      if (!(r.notices & ASKED)) { r.notices |= ASKED; actions.push({ type: "ask", ...ref(r), text: "Which session?" }); }
      return;
    }
    r.session_alias = alias;
    const wantsCorrection = intent === "correction" || (intent !== "new" && correction.test(r.text));
    const fresh = intent === "new" || newTask.test(r.text);
    const candidates = state.requests.filter((other) => other.id !== r.id && other.session_alias === alias &&
      currentRequest(state, other.id)?.revision === other.revision)
      .sort((a, b) => b.updated_at - a.updated_at);
    const inFlight = candidates.find((other) => correctionStates.includes(other.state));
    const needsClarification = candidates.some((other) => ["RECONCILE_REQUIRED", "RESULT_AVAILABLE", "SPOKEN"].includes(other.state));
    const active = inFlight ?? (intent === "correction"
      ? candidates.find(other => other.state === "READY" || other.state === "SPOKEN" || deliveryStates.includes(other.state))
      : !needsClarification && wantsCorrection ? candidates.find(other => other.state === "READY") : undefined);
    if (active && !fresh && wantsCorrection) {
      const oldDelivery = deliveryFor(active);
      setState(active, "SUPERSEDED");
      state.results = state.results.filter((result) => result.request_id !== active.id || result.revision !== active.revision);
      // The provisional request is replaced atomically by the next revision.
      state.requests = state.requests.filter((entry) => entry !== r);
      const next: Request = { ...r, id: active.id, revision: active.revision + 1, state: "READY", notices: 0 };
      state.requests.push(next);
      d.request_id = next.id; d.revision = next.revision; d.state = "READY";
      if (oldDelivery) dispatch(next, d, oldDelivery.id);
    } else if ((active || needsClarification) && !fresh) {
      setState(r, "WAITING_ROUTE");
      if (!(r.notices & ASKED)) { r.notices |= ASKED; actions.push({ type: "ask", ...ref(r), text: `Is that a correction or a new task for ${alias}?` }); }
    } else setState(r, "READY");
  };
  if (event.type === "delegation") {
    if (!event.id || !event.voice_epoch || !Number.isFinite(event.offset_ms) || event.offset_ms < 0) throw new Error("Invalid delegation");
    if (state.delegations.some((d) => d.id === event.id)) return { state, actions };
    const id = `request:${event.id}`;
    state.requests.push({ id, revision: 1, session_alias: "", state: "WAITING_TRANSCRIPT", text: "", created_at: now,
      updated_at: now, dispatched_at: null, acknowledged_at: null, stop_at: null, notices: 0 });
    state.delegations.push({ id: event.id, voice_epoch: event.voice_epoch, offset_ms: event.offset_ms,
      request_id: id, revision: 1, state: "WAITING_TRANSCRIPT", created_at: now });
  } else if (event.type === "transcript" || event.type === "resolve_route") {
    const d = state.delegations.find((d) => d.id === event.delegation_id);
    const r = d?.request_id ? currentRequest(state, d.request_id) : undefined;
    if (!d || !r || d.revision !== r.revision) return { state, actions };
    if (event.type === "transcript") {
      if (typeof event.text !== "string") throw new Error("Invalid transcript");
      if (r.state !== "WAITING_TRANSCRIPT" || !event.text.trim()) return { state, actions };
      r.text = event.text.trim(); r.notices = 0; setState(r, "WAITING_ROUTE");
      const routed = route(r.text);
      if (typeof routed !== "string") r.text = routed.text;
      assign(d, r, typeof routed === "string" ? routed : routed.alias);
    } else {
      if (!["new", "correction", "route"].includes(event.intent) || typeof event.alias !== "string") throw new Error("Invalid route resolution");
      if (r.state === "WAITING_ROUTE") {
        // Resolving the destination may uncover a separate correction/new-task ambiguity.
        if (!r.session_alias && event.intent === "route") r.notices &= ~ASKED;
        assign(d, r, event.alias, event.intent === "route" ? undefined : event.intent);
      }
    }
  } else if (event.type === "tick" || event.type === "recover") {
    for (const r of state.requests) {
      if (currentRequest(state, r.id)?.revision !== r.revision) continue;
      const d = deliveryFor(r);
      if (event.type === "recover") {
        if (d?.state === "DISPATCHING") {
          setState(r, "RECONCILE_REQUIRED"); r.notices |= RECONCILED;
          actions.push({ type: "reconcile", ...ref(r), delivery_id: d.id });
        }
        continue;
      }
      const status = (flag: number, status: Extract<Action, { type: "append_status" }>["status"], text: string) => {
        if (!(r.notices & flag)) { r.notices |= flag; actions.push({ type: "append_status", ...ref(r), status, text }); }
      };
      if (r.state === "WAITING_TRANSCRIPT") {
        if (now - r.created_at >= 2000) status(WAITING, "waiting", "Waiting for transcript.");
        if (now - r.created_at >= 8000 && !(r.notices & ASKED)) {
          r.notices |= ASKED; actions.push({ type: "ask", ...ref(r), text: "The transcript has not arrived. Please repeat the request." });
        }
      }
      if (!d || !deliveryStates.includes(r.state)) continue;
      const result = state.results.find((v) => v.request_id === r.id && v.revision === r.revision);
      const age = now - d.created_at;
      if (!result && r.acknowledged_at === null) {
        if (age >= 20000) status(UNCONFIRMED, "unconfirmed", `${r.session_alias} delivery unconfirmed.`);
        if (age >= 60000 && !(r.notices & RECONCILED)) {
          r.notices |= RECONCILED; setState(r, "RECONCILE_REQUIRED");
          actions.push({ type: "reconcile", ...ref(r), delivery_id: d.id });
        }
      }
      if (!result && age >= 120000) status(STILL_WORKING, "still_working", `${r.session_alias} is still working.`);
      if (!result && r.stop_at !== null && now - r.stop_at >= 3000) {
        status(STOPPED, "stopped", `${r.session_alias} finished, result is in the terminal`);
      }
    }
  } else if ("delivery_id" in event) {
    const d = state.deliveries.find((d) => d.id === event.delivery_id);
    const r = d ? currentRequest(state, d.request_id) : undefined;
    if (!d || !r || r.revision !== d.revision) return { state, actions };
    // Terminal reply identity survives export and speech. Even a conflicting
    // reply after SPOKEN is diagnosed, while the stored first reply wins.
    const existing = state.results.find((v) => v.request_id === r.id && v.revision === r.revision);
    if (event.type === "reply" && existing) {
      if (existing.status !== event.status || existing.text !== event.text) actions.push({ type: "diagnostic", delivery_id: d.id, text: "Conflicting terminal reply; first reply retained." });
      return { state, actions };
    }
    if (!deliveryStates.includes(r.state)) return { state, actions };
    if (event.type === "reply") {
      if (!["completed", "failed", "question"].includes(event.status) || typeof event.text !== "string") throw new Error("Invalid reply");
      state.results.push({ ...ref(r), status: event.status, text: event.text, source: "reply", created_at: now });
      setState(r, event.status === "question" ? "WAITING_USER" : "RESULT_LOCAL");
    } else if (event.type === "stop") { r.stop_at ??= now; }
    else if (event.type === "acknowledge") {
      r.acknowledged_at ??= now;
      if (["DISPATCHING", "DELIVERED", "RECONCILE_REQUIRED"].includes(r.state)) setState(r, "ACKNOWLEDGED");
    } else if (event.type === "delivered") {
      if (r.state === "DISPATCHING") setState(r, "DELIVERED");
    } else throw new Error("Unknown delivery event");
  } else if ("request_id" in event) {
    const r = currentRequest(state, event.request_id);
    if (!r || r.revision !== event.revision || ["SUPERSEDED", "CANCELLED", "FAILED", "SPOKEN"].includes(r.state)) return { state, actions };
    if (event.type === "dispatch") {
      const d = state.delegations.find((d) => d.request_id === r.id && d.revision === r.revision);
      if (d) dispatch(r, d, state.deliveries.find(v => v.request_id === r.id && v.revision === r.revision - 1)?.id);
    } else if (event.type === "export_blocked") {
      if (["RESULT_LOCAL", "WAITING_USER"].includes(r.state)) setState(r, "EXPORT_BLOCKED");
    } else if (event.type === "export_result") {
      const result = state.results.find((v) => v.request_id === r.id && v.revision === r.revision);
      if (result && ["RESULT_LOCAL", "EXPORT_BLOCKED", "WAITING_USER"].includes(r.state)) {
        setState(r, "RESULT_AVAILABLE");
        actions.push({ type: "append_result", ...ref(r), session_alias: r.session_alias, text: `${r.session_alias}: ${result.text}` });
      }
    } else if (event.type === "spoken") {
      if (r.state === "RESULT_AVAILABLE") setState(r, "SPOKEN");
    } else if (event.type === "cancel" || event.type === "fail") setState(r, event.type === "cancel" ? "CANCELLED" : "FAILED");
    else throw new Error("Unknown request event");
  } else throw new Error("Unknown request event");
  return { state, actions };
}

const tableNames = ["requests", "deliveries", "results", "delegations"] as const;
export class RequestMachine {
  readonly recoveryActions: Action[];
  constructor(readonly db: Database, readonly route: Route = () => "default", now = 0, readonly canDispatch: (alias: string) => boolean = () => true) {
    this.recoveryActions = this.handle({ type: "recover" }, now);
  }
  snapshot(): RequestStore {
    return Object.fromEntries(tableNames.map((table) => [table, this.db.query(`SELECT * FROM ${table}`).all()])) as RequestStore;
  }
  handle(event: RequestEvent, now: number): Action[] {
    // Compute and commit in the same transaction; return actions only after commit.
    return this.db.transaction(() => {
      const previous = this.snapshot();
      const { state, actions } = requestStep(previous, event, now, this.route, this.canDispatch);
      for (const table of ["results", "deliveries", "delegations", "requests"] as const) this.db.exec(`DELETE FROM ${table}`);
      for (const table of tableNames) for (const row of state[table]) {
        const columns = Object.keys(row);
        this.db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
          .run(...Object.values(row));
      }
      return actions;
    })();
  }
}
