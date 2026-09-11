import type { Database } from "bun:sqlite";
import { currentRequest, RequestMachine, type Action, type RequestEvent } from "./requests";
import { emptyTranscripts, transcriptStep, type TranscriptEvent } from "./transcripts";
import { Ledger, type Caps } from "./ledger";
import { type Candidate, type Context, type Policy, payloadHash, releasePayload, sessionPolicy, statusText, validAlias } from "./egress";
import type { LivePort } from "./live";
import { object, validTool } from "../shim/protocol";
import { hookMetadata } from "../shim/hook";
export type Session = { alias: string; cwd: string; token: string; send?: (value: unknown) => void };
export type BrokerOptions = { db: Database; policy: () => Policy | null; secrets: readonly string[]; secretsReady?: boolean; live: LivePort;
  now?: () => number; log?: (event: Record<string, unknown>) => void; caps?: Caps };
export class Broker {
  readonly sessions = new Map<string, Session>();
  readonly requests: RequestMachine;
  readonly ledger: Ledger;
  readonly live: LivePort;
  approvalTTY = false;
  #transcripts = emptyTranscripts();
  #epoch = "";
  #epochStarted = 0;
  #active = false;
  #busy = new Set<string>();
  #owners = new Map<string, string>();
  #rejected = new Set<string>();
  #timer?: ReturnType<typeof setInterval>;
  #now: () => number;
  constructor(private options: BrokerOptions) {
    this.#now = options.now ?? Date.now;
    this.live = options.live;
    this.requests = new RequestMachine(options.db, () => this.sessions.keys().next().value ?? "AMBIGUOUS", this.#now());
    this.ledger = new Ledger(options.db, options.caps ?? { activation_usd: 0.50, daily_usd: 3, idle_ms: 180_000 });
    options.db.exec("CREATE TABLE IF NOT EXISTS sessions (alias TEXT PRIMARY KEY, cwd TEXT NOT NULL, token_hash TEXT NOT NULL)");
    this.actions(this.requests.recoveryActions);
  }
  log(event: Record<string, unknown>) { this.options.log?.({ at: this.#now(), ...event }); }
  start() { this.#timer = setInterval(() => this.tick(), 250); }
  async stop() { clearInterval(this.#timer); await this.live.close("broker shutdown"); }
  register(alias: string, cwd: string, token: string) {
    if (!validAlias(alias) || !/^[a-f0-9]{64}$/.test(token) || !sessionPolicy(this.options.policy(), alias, cwd)) throw new Error("Session refused by policy");
    if (this.sessions.size && (!this.sessions.has(alias) || this.sessions.get(alias)?.send)) throw new Error("P2 supports one session");
    this.sessions.set(alias, { alias, cwd, token });
    this.options.db.query("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)").run(alias, cwd, payloadHash(token));
    this.log({ type: "registered", alias });
  }
  authenticate(alias: string, token: string) { return validAlias(alias) && this.sessions.get(alias)?.token === token; }
  connect(alias: string, token: string, send: (value: unknown) => void) {
    if (!this.authenticate(alias, token)) throw new Error("Unauthorized session");
    const s = this.sessions.get(alias)!;
    if (s.send) throw new Error("Session already connected");
    s.send = send;
    return () => { if (s.send === send) s.send = undefined; };
  }
  ready(alias: string) {
    for (const r of this.requests.snapshot().requests) if (r.session_alias === alias && r.state === "READY") this.handle({ type: "dispatch", request_id: r.id, revision: r.revision });
  }
  handle(event: RequestEvent) {
    const previous = this.requests.snapshot();
    const actions = this.requests.handle(event, this.#now());
    const next = this.requests.snapshot();
    for (const old of previous.requests) {
      const current = currentRequest(next, old.id);
      if (current?.revision !== old.revision || ["SUPERSEDED", "CANCELLED", "FAILED"].includes(current.state)) {
        this.live.egress.revoke(old.id, old.revision);
        if (old.state === "RESULT_AVAILABLE") void this.live.close("exported revision retired");
      }
    }
    this.actions(actions);
  }
  actions(actions: Action[]) {
    for (const action of actions) {
      if (action.type === "deliver") {
        const s = this.sessions.get(action.session_alias);
        const policy = s?.send && sessionPolicy(this.options.policy(), s.alias, s.cwd);
        if (!s?.send || !policy || policy.level === "off") {
          this.log({ type: "ask", request_id: action.request_id, text: "That session is not available by voice." });
          continue;
        }
        this.#owners.set(action.delivery_id, s.token);
        try {
          s.send({ content: action.supersedes ? `Correction replacing ${action.supersedes}: ${action.text}` : action.text,
            meta: { request_id: action.request_id, revision: String(action.revision), delivery_id: action.delivery_id, session_alias: s.alias } });
          this.handle({ type: "delivered", delivery_id: action.delivery_id });
          this.log({ ...action, type: "delivered", text: undefined });
          void this.emitStatus(action.request_id, action.revision, 0);
        } catch { this.log({ type: "delivery_unconfirmed", request_id: action.request_id }); }
      } else if (action.type === "append_status") {
        void this.emitStatus(action.request_id, action.revision, action.status === "stopped" ? 3 : 1);
      } else if (action.type === "ask") {
        this.log(action);
        void this.emitStatus(action.request_id, action.revision, 4);
      } else if (action.type !== "append_result") this.log(action);
    }
  }
  context(requestId: string, revision: number, source: Context["source"]): Context {
    const r = currentRequest(this.requests.snapshot(), requestId);
    const s = r && this.sessions.get(r.session_alias);
    return { request_id: requestId, revision, session_alias: r?.session_alias ?? "", cwd: s?.cwd ?? "",
      policy: this.options.policy(), secrets: this.options.secrets, secretsReady: this.options.secretsReady, source,
      current: !!s && r?.revision === revision && !["SUPERSEDED", "FAILED", "CANCELLED"].includes(r.state) };
  }
  async emitStatus(id: string, revision: number, index: number) {
    if (!this.live.awake) return;
    const context = () => this.context(id, revision, "status");
    const ctx = context();
    try {
      const decision = await this.live.egress.emit("commentary", statusText(index, ctx.session_alias), ctx.session_alias, context, this.delegation(id, revision));
      this.log({ type: "status", request_id: id, revision, index, allowed: decision.allowed });
    } catch { this.log({ type: "append_unconfirmed", request_id: id, revision }); }
  }
  delegation(id: string, revision: number) {
    return this.requests.snapshot().delegations.find(d => d.request_id === id && d.revision === revision && d.voice_epoch === this.#epoch)?.id ?? null;
  }
  tool(alias: string, token: string, name: unknown, args: unknown) {
    if (!this.authenticate(alias, token) || !validTool(name, args) || !object(args) || args.session_alias !== alias) throw new Error("Invalid tool identity");
    const d = this.requests.snapshot().deliveries.find(d => d.id === args.delivery_id);
    const r = d && currentRequest(this.requests.snapshot(), d.request_id);
    if (!d || !r || r.session_alias !== alias || d.request_id !== args.request_id || d.revision !== Number(args.revision) ||
      r.revision !== d.revision || this.#owners.get(d.id) !== token) throw new Error("Delivery ownership mismatch");
    if (name === "acknowledge") this.handle({ type: "acknowledge", delivery_id: d.id });
    else this.handle({ type: "reply", delivery_id: d.id, status: args.status as "completed" | "failed" | "question", text: args.text as string });
    this.log({ type: name === "reply" ? "replied" : "acknowledged", request_id: r.id, revision: r.revision });
    if (name === "reply") void this.export(r.id, r.revision);
  }
  hook(alias: string, token: string, value: unknown) {
    if (!this.authenticate(alias, token)) throw new Error("Unauthorized hook");
    const metadata = hookMetadata(value);
    // The event name is the only hook field retained in the journal. Never export metadata strings.
    this.log({ type: "hook", alias, event: metadata.hook_event_name });
    const r = this.requests.snapshot().requests.filter(r => r.session_alias === alias && ["DELIVERED", "ACKNOWLEDGED", "DISPATCHING"].includes(r.state)).sort((a, b) => b.updated_at - a.updated_at)[0];
    if (!r) return;
    const d = this.requests.snapshot().deliveries.find(d => d.request_id === r.id && d.revision === r.revision);
    if (metadata.hook_event_name === "Stop" && d) this.handle({ type: "stop", delivery_id: d.id });
    if (metadata.hook_event_name === "PermissionRequest") void this.emitStatus(r.id, r.revision, 2);
  }
  pending(): Candidate[] {
    const store = this.requests.snapshot();
    return store.results.flatMap(result => {
      const r = currentRequest(store, result.request_id), ctx = this.context(result.request_id, result.revision, "reply");
      if (!r || !ctx.current || r.revision !== result.revision || !["RESULT_LOCAL", "EXPORT_BLOCKED", "WAITING_USER"].includes(r.state) ||
        sessionPolicy(ctx.policy, ctx.session_alias, ctx.cwd)?.level !== "release" || this.#rejected.has(`${r.id}:${r.revision}`)) return [];
      const text = releasePayload(r.session_alias, result.text);
      return [{ request_id: r.id, revision: r.revision, session_alias: r.session_alias, text, hash: payloadHash(text) }];
    });
  }
  approve(hash: string, id: string, revision: number) {
    if (!this.approvalTTY) throw new Error("Approval requires serve TTY");
    if (!this.pending().some(p => p.request_id === id && p.revision === revision && p.hash === hash)) throw new Error("Approval no longer matches pending payload");
    this.live.egress.approve(hash, id, revision);
    this.log({ type: "approved", request_id: id, revision });
    void this.export(id, revision);
  }
  reject(id: string, revision: number) {
    this.live.egress.revoke(id, revision); this.#rejected.add(`${id}:${revision}`);
    const r = currentRequest(this.requests.snapshot(), id);
    if (r?.state === "RESULT_AVAILABLE") void this.live.close("release revoked after append");
    this.log({ type: "rejected", request_id: id, revision });
  }
  async export(id: string, revision: number) {
    const key = `${id}:${revision}`;
    if (this.#busy.has(key) || this.#rejected.has(key)) return;
    const store = this.requests.snapshot(), r = currentRequest(store, id);
    const result = store.results.find(v => v.request_id === id && v.revision === revision);
    if (!r || r.revision !== revision || !result || !["RESULT_LOCAL", "EXPORT_BLOCKED", "WAITING_USER"].includes(r.state)) return;
    this.#busy.add(key);
    try {
      // Mark uncertain before the first byte; crashes cannot replay a partially sent result.
      const context = () => {
        const ctx = this.context(id, revision, "reply");
        return { ...ctx, current: ctx.current && !this.#rejected.has(key) };
      };
      if (!this.live.awake) { this.handle({ type: "export_blocked", request_id: id, revision }); return; }
      const decision = await this.live.egress.emit("commentary", result.text, r.session_alias, context,
        this.delegation(id, revision), () => this.handle({ type: "export_result", request_id: id, revision }));
      this.log({ type: "egress", request_id: id, revision, allowed: decision.allowed, reason: decision.reason });
      if (decision.allowed) {
        this.handle({ type: "export_result", request_id: id, revision });
        // APPENDED confirms injection, not actual speech. Keep RESULT_AVAILABLE.
        this.log({ type: "append_confirmed", request_id: id, revision });
      } else this.handle({ type: "export_blocked", request_id: id, revision });
    } catch {
      this.handle({ type: "export_result", request_id: id, revision });
      this.log({ type: "append_unconfirmed", request_id: id, revision });
    } finally { this.#busy.delete(key); }
  }
  transcript(event: TranscriptEvent) {
    const stepped = transcriptStep(this.#transcripts, event, this.#now()); this.#transcripts = stepped.state;
    for (const a of stepped.ready) {
      this.handle({ type: "transcript", delegation_id: a.id, text: a.text });
      const d = this.requests.snapshot().delegations.find(d => d.id === a.id);
      const r = d?.request_id && currentRequest(this.requests.snapshot(), d.request_id);
      if (r && r.state === "READY") {
        const s = this.sessions.get(r.session_alias), p = s && sessionPolicy(this.options.policy(), s.alias, s.cwd);
        if (!p || p.level === "off") this.log({ type: "ask", request_id: r.id, text: "That session is not available by voice." });
        else if (s?.send) this.handle({ type: "dispatch", request_id: r.id, revision: r.revision });
      }
    }
  }
  event(e: Record<string, unknown>) {
    if (e.type === "session.started") {
      this.ledger.handle({ type: "session.started", voice_epoch: this.#epoch }, this.#now());
      for (const result of this.requests.snapshot().results) void this.export(result.request_id, result.revision);
    } else if (e.type === "session.usage.updated" || e.type === "session.closed") {
      if (object(e.usage) && typeof e.usage.seconds === "number" && Number.isFinite(e.usage.seconds) && e.usage.seconds >= 0) {
        const actions = this.ledger.handle({ type: e.type, voice_epoch: this.#epoch, seconds: e.usage.seconds }, this.#now());
        this.log({ type: e.type, epoch: this.#epoch, seconds: e.usage.seconds, finalized: e.type === "session.closed" });
        if (actions.length) void this.live.close(actions[0]!.reason);
      } else this.log({ type: "usage_unconfirmed", epoch: this.#epoch });
    } else if (e.type === "transport.closed") {
      const usage = this.ledger.snapshot().find(u => u.voice_epoch === this.#epoch);
      if (usage && !usage.finalized) {
        const seconds = Math.max(usage.seconds, (this.#now() - this.#epochStarted) / 1000);
        this.ledger.handle({ type: "session.usage.updated", voice_epoch: this.#epoch, seconds }, this.#now());
        this.log({ type: "usage_unconfirmed", epoch: this.#epoch, seconds, source: "conservative wall clock" });
      }
      this.#active = false; this.log({ type: "transport.closed", epoch: this.#epoch });
    }
    else if (e.type === "session.input_transcript.delta") {
      if (typeof e.start_ms !== "number" || typeof e.end_ms !== "number" || typeof e.delta !== "string") throw new Error("Invalid transcript");
      this.transcript({ type: "fragment", fragment: { start_ms: e.start_ms, end_ms: e.end_ms, delta: e.delta } });
    } else if (e.type === "session.delegation.created") {
      if (!object(e.delegation) || typeof e.delegation.id !== "string" || typeof e.offset_ms !== "number") throw new Error("Invalid delegation");
      this.handle({ type: "delegation", id: e.delegation.id, voice_epoch: this.#epoch, offset_ms: e.offset_ms });
      this.transcript({ type: "delegation", id: e.delegation.id, offset_ms: e.offset_ms });
    } else if (e.type === "local.silence" && typeof e.silent === "boolean") {
      this.transcript({ type: "silence", at_ms: this.#now(), silent: e.silent });
      if (!e.silent) this.ledger.handle({ type: "activity", voice_epoch: this.#epoch }, this.#now());
    } else if (e.type === "session.output_transcript.delta" && typeof e.delta === "string") this.log({ type: "output_transcript", delta: e.delta });
  }
  wake() {
    if (this.#active) throw new Error("Voice already active");
    const daily = this.ledger.snapshot().filter(u => u.day === new Date(this.#now()).toISOString().slice(0, 10)).reduce((s, u) => s + u.usd, 0);
    if (daily >= this.ledger.caps.daily_usd) throw new Error("Daily voice cap reached");
    this.#epoch = crypto.randomUUID(); this.#epochStarted = this.#now(); this.#transcripts = emptyTranscripts();
    this.ledger.handle({ type: "session.started", voice_epoch: this.#epoch }, this.#now());
    this.live.wake(); this.#active = true;
  }
  tick() {
    this.transcript({ type: "tick" }); this.handle({ type: "tick" });
    if (this.#active) {
      const actions = this.ledger.handle({ type: "tick", voice_epoch: this.#epoch }, this.#now());
      // Reserve 11 seconds for close even if server usage snapshots stall.
      const daily = this.ledger.snapshot().filter(u => u.day === new Date(this.#now()).toISOString().slice(0, 10) && u.voice_epoch !== this.#epoch).reduce((s, u) => s + u.usd, 0);
      const seconds = Math.min(this.ledger.caps.activation_usd, this.ledger.caps.daily_usd - daily) / 0.05 * 60 - 11;
      if (actions.length || this.#now() - this.#epochStarted >= seconds * 1000) void this.live.close(actions[0]?.reason ?? "wall clock cap");
    }
  }
  status() { return { caps: this.ledger.caps, voice: this.live.awake ? "awake" : "asleep",
    approval: this.approvalTTY ? "TTY keystroke only" : "unavailable (serve has no TTY)",
    sessions: [...this.sessions.values()].map(s => ({ alias: s.alias, connected: !!s.send })), requests: this.requests.snapshot().requests,
    pending: this.pending().map(({ hash, ...candidate }) => candidate), usage: this.ledger.snapshot() }; }
}
