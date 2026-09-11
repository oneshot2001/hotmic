import { readFileSync } from "node:fs";
import { Audio, type AudioIO } from "./audio";
import { Egress, type Append } from "./egress";
import { object } from "../shim/protocol";
export interface LivePort { readonly egress: Egress; readonly awake: boolean; wake(): void; close(reason: string): Promise<void> }
export type LiveOptions = { key: string; event: (event: Record<string, unknown>) => void;
  audit: (event: Record<string, unknown>) => void;
  socket?: () => WebSocket; audio?: (input: (frame: Buffer, silent: boolean) => void, fail: () => void) => AudioIO };
export class Live implements LivePort {
  readonly egress: Egress;
  #ws?: WebSocket;
  #audio?: AudioIO;
  #ready = false;
  #closing = false;
  #done?: () => void;
  #closed: Promise<void> = Promise.resolve();
  #timer?: ReturnType<typeof setTimeout>;
  #pending = new Map<string, { kind: string; resolve: () => void; reject: () => void }>();
  constructor(private options: LiveOptions) { this.egress = new Egress(append => this.#appendRaw(append)); }
  get awake() { return this.#ready && !this.#closing; }
  wake() {
    if (this.#ws) throw new Error("Voice already active or closing");
    if (!this.options.key) throw new Error("OPENAI_API_KEY unavailable");
    this.#closing = false;
    this.#closed = new Promise(resolve => { this.#done = resolve; });
    const ws = this.options.socket?.() ?? new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${this.options.key}` } });
    this.#ws = ws;
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      this.#send({ type: "session.start", event_id: crypto.randomUUID(), session: {
        model: "gpt-live-1", delegation: { type: "client" }, store: false,
        audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
        instructions: readFileSync(new URL("../prompts/live.txt", import.meta.url), "utf8"),
      } });
      if (this.#closing) this.#send({ type: "session.close" });
    });
    ws.addEventListener("message", message => {
      if (this.#ws !== ws) return;
      try {
        const e: unknown = JSON.parse(String(message.data));
        if (!object(e) || typeof e.type !== "string") throw new Error("Invalid Live event");
        if (typeof e.client_event_id === "string") {
          const pending = this.#pending.get(e.client_event_id);
          if (pending && (e.type === `session.${pending.kind}.appended` || e.type === "error")) {
            this.#pending.delete(e.client_event_id);
            e.type === "error" ? pending.reject() : pending.resolve();
          }
        }
        if (e.type === "error") { void this.close("server error"); return; }
        if (e.type === "session.closed") {
          this.options.event(e); ws.close(); this.#finish(); return;
        }
        if (e.type === "session.usage.updated") { this.options.event(e); return; }
        if (this.#closing) return;
        if (e.type === "session.started" && !this.#ready) {
          this.#ready = true;
          this.options.event(e);
          const input = (frame: Buffer, silent: boolean) => {
            if (!this.awake) return;
            this.options.event({ type: "local.silence", silent });
            this.#send({ type: "session.input_audio.append", audio: frame.toString("base64") });
          };
          const fail = () => { void this.close("audio failed"); };
          this.#audio = this.options.audio?.(input, fail) ?? new Audio(input, fail);
          this.#audio.start();
        } else if (e.type === "session.output_audio.delta") {
          if (typeof e.delta !== "string") throw new Error("Invalid audio");
          this.#audio?.output(Buffer.from(e.delta, "base64"));
        } else this.options.event(e);
      } catch { void this.close("contract error"); }
    });
    ws.addEventListener("error", () => { if (this.#ws === ws) void this.close("transport error"); });
    ws.addEventListener("close", () => { if (this.#ws === ws) this.#finish(); });
  }
  #send(event: Record<string, unknown>) {
    if (this.#ws?.readyState !== WebSocket.OPEN) throw new Error("Voice unavailable");
    this.#ws.send(JSON.stringify(event));
  }
  #appendRaw(append: Append): Promise<void> {
    if (!this.awake) return Promise.reject(new Error("Voice asleep"));
    const event_id = crypto.randomUUID();
    const frame = { type: `session.${append.kind}.append`, event_id, delegation_id: append.delegation_id, content: append.content };
    return new Promise((resolve, reject) => {
      this.#pending.set(event_id, { kind: append.kind, resolve, reject: () => reject(new Error("Append not confirmed")) });
      try {
        // Journal exact authorized text before transport; crash leaves an uncertain export, never an automatic resend.
        this.options.audit({ type: "outbound", request_id: append.request_id, revision: append.revision, session_alias: append.session_alias, source: append.source, frame });
        this.#send(frame);
      } catch { this.#pending.delete(event_id); reject(new Error("Append failed")); }
    });
  }
  close(reason: string): Promise<void> {
    if (!this.#ws || this.#closing) return this.#closed;
    this.#closing = true; this.#ready = false; this.#audio?.stop();
    this.options.audit({ type: "close_requested", reason });
    if (this.#ws.readyState === WebSocket.OPEN) this.#send({ type: "session.close" });
    this.#timer = setTimeout(() => { this.#ws?.terminate(); this.#finish(); }, 10_000);
    return this.#closed;
  }
  #finish() {
    if (!this.#ws) return;
    clearTimeout(this.#timer); this.#audio?.stop();
    for (const p of this.#pending.values()) p.reject();
    this.#pending.clear(); this.#ws = undefined; this.#ready = false;
    this.options.event({ type: "transport.closed" }); this.#done?.();
  }
}
