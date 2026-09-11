import { test, expect, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { openDB } from "../src/db";
import { Broker } from "../src/broker";
import { attachSocket } from "../src/sock";
import { Egress } from "../src/egress";
import { serveTerminal } from "../src/terminal";
import { FakeLive, FakeTTY, sandbox, drain } from "./p2-helpers";
class Shim extends EventEmitter {
  destroyed = false; output = "";
  constructor(readonly broker: Broker, readonly alias: string, readonly token: string) {
    super(); attachSocket(this as unknown as Socket, broker, "control");
    this.input({ type: "connect", alias, token }); this.input({ type: "channel_ready" });
  }
  setTimeout() { return this; }
  write(bytes: string) { this.output += bytes; return true; }
  end(bytes = "") { this.write(bytes); this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
  input(value: unknown) { if (!this.destroyed) this.emit("data", Buffer.from(JSON.stringify(value) + "\n")); }
  get deliveries() { return this.output.trim().split("\n").filter(Boolean).map(s => JSON.parse(s)).filter(v => v.meta); }
  reply(meta = this.deliveries.at(-1)?.meta, text = "done", status = "completed") { this.input({ type: "tool_call", name: "reply", arguments: { ...meta, status, text } }); }
}
function multi() {
  const files = sandbox("summary"), db = openDB(), live = new FakeLive();
  let now = 10000, offset = 0, number = 0;
  const events: any[] = [];
  for (const alias of ["alpha", "bravo", "charlie", "off"]) files.policy.sessions[alias] = { root: files.root, level: alias === "off" ? "off" : "summary", aliases: alias === "alpha" ? ["al fa"] : [] };
  const broker = new Broker({ db, live, policy: () => files.policy, secrets: [], now: () => now, log: e => events.push(e) });
  const shims = ["alpha", "bravo", "charlie", "off"].map((alias, i) => {
    const token = String(i + 1).repeat(64);
    broker.register(alias, files.root, token, { workspace_ref: "workspace:1", surface_ref: `surface:${i}` });
    return new Shim(broker, alias, token);
  });
  broker.wake();
  const heartbeat = () => shims.filter(s => !s.destroyed).forEach(s => s.input({ type: "heartbeat" }));
  const advance = (ms: number) => { now += ms; broker.tick(); };
  const fragment = (text: string) => {
    heartbeat(); offset += 5000;
    broker.event({ type: "local.silence", silent: false });
    broker.event({ type: "session.input_transcript.delta", start_ms: offset, end_ms: offset + 100, delta: text });
  };
  const settle = () => {
    const id = `p3-${++number}`;
    broker.event({ type: "local.silence", silent: true });
    broker.event({ type: "session.delegation.created", delegation: { id }, offset_ms: offset + 100 });
    advance(900); return id;
  };
  const say = (text: string) => { fragment(text); return settle(); };
  return { ...files, broker, db, live, shims, events, say, fragment, settle, advance,
    cleanup: async () => { await drain(); db.close(); files.cleanup(); } };
}
test("three authenticated shims receive only their destinations, strip aliases, reject cross-session replies", async () => {
  const h = multi();
  try {
    h.say("al fa, run tests"); h.say("bravo, run tests"); h.say("charlie, ask alpha to review tests");
    expect(h.shims.slice(0, 3).map(s => s.deliveries.length)).toEqual([1, 1, 1]);
    expect(h.shims[0]!.deliveries[0].content).toBe("run tests");
    expect(h.shims[2]!.deliveries[0].content).toBe("ask alpha to review tests");
    const a = h.shims[0]!, b = h.shims[1]!;
    b.reply({ ...a.deliveries[0].meta, session_alias: "bravo" }, "STOLEN");
    expect(b.output).toContain('"ok":false'); expect(h.broker.requests.snapshot().results).toHaveLength(0);
    a.reply(); await drain(); expect(h.live.frames.some(f => f.content === "alpha: done")).toBe(true);
    expect(JSON.stringify(h.live.frames)).not.toContain("STOLEN");
  } finally { await h.cleanup(); }
});
test("focus captured at first fragment, not delegation; ask resolves by resampled that one or explicit alias", async () => {
  const h = multi();
  try {
    h.broker.focused = { surface_ref: "surface:0", workspace_ref: "workspace:1" };
    h.fragment("run tests"); h.broker.focused = { surface_ref: "surface:1", workspace_ref: "workspace:1" }; h.settle();
    expect(h.shims[0]!.deliveries).toHaveLength(1); expect(h.shims[1]!.deliveries).toHaveLength(0);
    h.broker.focused = { surface_ref: "surface:serve", workspace_ref: "workspace:1" };
    h.say("New task: fix tests"); await drain();
    expect(h.live.frames.some(f => f.content === "Which session? Live: alpha, bravo, charlie")).toBe(true);
    expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE")).toHaveLength(1);
    h.broker.focused = { surface_ref: "surface:1", workspace_ref: "workspace:1" }; h.say("that one");
    expect(h.shims[1]!.deliveries.map(d => d.content)).toEqual(["New task: fix tests"]);
    h.broker.focused = { surface_ref: "surface:serve", workspace_ref: "workspace:1" };
    h.say("New task: read tests"); h.say("charlie");
    expect(h.shims[2]!.deliveries.map(d => d.content)).toEqual(["New task: read tests"]);
    expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE")).toHaveLength(0);
  } finally { await h.cleanup(); }
});
test("pin confirmation is not a task, pins refresh on requests and expire without requests", async () => {
  const h = multi();
  try {
    h.say("talk to bravo"); await drain();
    expect(h.live.frames.some(f => f.content === "Talking to bravo.")).toBe(true);
    expect(h.shims.every(s => s.deliveries.length === 0)).toBe(true);
    h.advance(299000); h.say("New task: run tests");
    expect(h.shims[1]!.deliveries).toHaveLength(1); expect(h.broker.status().pinned?.alias).toBe("bravo");
    h.advance(300000); expect(h.broker.status().pinned).toBeNull();
    h.broker.focused = { surface_ref: "surface:2", workspace_ref: "workspace:1" }; h.say("New task: read tests");
    expect(h.shims[2]!.deliveries).toHaveLength(1);
  } finally { await h.cleanup(); }
});
test("held follow-up asks correction versus new task and next utterance resolves once", async () => {
  for (const response of ["correction", "yes, correction", "instead", "new task", "separate", "no"]) {
    const h = multi();
    try {
      h.say("alpha, run tests"); h.say("alpha, read tests"); await drain();
      expect(h.shims[0]!.deliveries).toHaveLength(1);
      expect(h.live.frames.some(f => f.content === "Is that a correction or a new task for alpha?")).toBe(true);
      h.say(response); await drain();
      const deliveries = h.shims[0]!.deliveries;
      expect(deliveries).toHaveLength(2);
      const correct = ["correction", "yes, correction", "instead"].includes(response);
      expect(deliveries[1].meta.revision).toBe(correct ? "2" : "1");
      expect(deliveries[1].content).toContain("read tests");
      expect(deliveries[1].meta.request_id === deliveries[0].meta.request_id).toBe(correct);
      expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE")).toHaveLength(0);
    } finally { await h.cleanup(); }
  }
});
test("disconnect retains queued and in-flight work, announces once, same-token reconnect sends only queued work", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); await drain(); h.live.frames.length = 0;
    h.shims[0]!.destroy(); h.say("alpha, New task: read tests"); await drain();
    const before = h.broker.requests.snapshot();
    expect(before.requests.filter(r => r.session_alias === "alpha").map(r => r.state)).toEqual(["DELIVERED", "READY"]);
    expect(before.deliveries).toHaveLength(1);
    h.advance(6000); h.advance(6000); await drain();
    expect(h.live.frames.filter(f => f.content === "alpha is not responding")).toHaveLength(1);
    const reconnect = new Shim(h.broker, "alpha", h.shims[0]!.token);
    expect(reconnect.deliveries.map(d => d.content)).toEqual(["New task: read tests"]);
    expect(h.broker.status().sessions.find(s => s.alias === "alpha")?.connected).toBe(true);
    reconnect.reply(h.shims[0]!.deliveries[0].meta, "late but owned"); await drain();
    expect(h.live.frames.some(f => f.content === "alpha: late but owned")).toBe(true);
  } finally { await h.cleanup(); }
});
test("heartbeat timeout retains delivery, restores channel and rejects the replaced transport", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); await drain(); h.live.frames.length = 0;
    h.advance(5100); await drain(); // six seconds from last heartbeat
    expect(h.broker.status().sessions[0]?.connected).toBe(false);
    expect(h.live.frames.filter(f => f.content === "alpha is not responding")).toHaveLength(1);
    h.advance(100); await drain(); expect(h.live.frames.filter(f => f.content === "alpha is not responding")).toHaveLength(1);
    h.shims[0]!.input({ type: "heartbeat" }); expect(h.broker.status().sessions[0]?.connected).toBe(true);
    h.advance(6000); const replacement = new Shim(h.broker, "alpha", h.shims[0]!.token);
    h.shims[0]!.input({ type: "heartbeat" }); expect(h.shims[0]!.destroyed).toBe(true);
    expect(h.broker.sessions.get("alpha")?.connected).toBe(true);
    replacement.reply(h.shims[0]!.deliveries[0].meta); await drain();
    expect(h.broker.requests.snapshot().deliveries).toHaveLength(1);
  } finally { await h.cleanup(); }
});
test("queued correction retains supersedes reference and off/unregistered destinations never dispatch", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); h.shims[0]!.destroy(); h.say("alpha, Actually, replace that with checks");
    expect(h.broker.requests.snapshot().deliveries).toHaveLength(1);
    const reconnect = new Shim(h.broker, "alpha", h.shims[0]!.token);
    expect(reconnect.deliveries[0].content).toContain(`Correction replacing ${h.shims[0]!.deliveries[0].meta.delivery_id}`);
    h.say("off, run tests"); await drain(); expect(h.shims[3]!.deliveries).toHaveLength(0);
    expect(h.live.frames.some(f => f.content === "That session is not available by voice.")).toBe(true);
    h.say("missing, run tests"); expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE").length).toBeGreaterThan(0);
  } finally { await h.cleanup(); }
});
test("broker queue prioritizes simultaneous question and permission over complete multi-chunk results", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); h.say("bravo, run tests"); h.say("charlie, run tests"); await drain(); h.live.frames.length = 0;
    h.shims[0]!.reply(undefined, "x".repeat(1500)); h.shims[1]!.reply(undefined, "question", "question");
    h.broker.hook("charlie", h.shims[2]!.token, { hook_event_name: "PermissionRequest", session_id: "s" });
    await drain();
    expect(h.live.frames.map(f => f.session_alias)).toEqual(["bravo", "charlie", "alpha", "alpha"]);
    expect(h.live.frames[0]!.content).toBe("bravo: question");
    expect(h.live.frames.slice(2).map(f => f.content).join("")).toBe("alpha: " + "x".repeat(1500));
  } finally { await h.cleanup(); }
});
test("queued result rechecks revision before export, and status lists every session and pending count", async () => {
  const h = multi();
  let release!: () => void;
  try {
    h.say("alpha, run tests"); await drain();
    const gate = new Promise<void>(r => { release = r; });
    h.live.egress = new Egress(async append => { if (append.content.startsWith("Talking")) await gate; h.live.frames.push(append); });
    h.say("talk to bravo"); await drain();
    h.shims[0]!.reply(undefined, "OLD"); h.say("alpha, Actually, replace that with checks");
    release(); await drain(); expect(h.live.frames.some(f => f.content === "alpha: OLD")).toBe(false);
    h.policy.sessions.bravo!.level = "release"; h.say("bravo, New task: run tests"); h.shims[1]!.reply(); await drain();
    h.broker.focused = { surface_ref: "surface:1", workspace_ref: "workspace:1" };
    const lines: string[] = [], terminal = serveTerminal(h.broker, new FakeTTY(), s => lines.push(s));
    terminal.render(); terminal.close();
    for (const name of ["alpha", "bravo", "charlie", "off"]) expect(lines[0]).toContain(name + " |");
    expect(lines[0]).toContain("bravo | EXPORT_BLOCKED | connected | * | 1");
    expect(h.broker.status().focused.surface_ref).toBe("surface:1");
    h.broker.focused = { surface_ref: "surface:3", workspace_ref: "workspace:1" };
    expect(h.broker.status().sessions.find(s => s.alias === "off")?.focused).toBe(true);
  } finally { release?.(); await h.cleanup(); }
});
test("delivery alias guard rejects a different session even when capabilities happen to match", async () => {
  const h = multi();
  try {
    h.broker.register("other", h.root, h.shims[0]!.token);
    const other = new Shim(h.broker, "other", h.shims[0]!.token);
    h.say("alpha, run tests"); await drain();
    other.reply({ ...h.shims[0]!.deliveries[0].meta, session_alias: "other" }, "STOLEN");
    expect(other.output).toContain('"ok":false');
    expect(h.broker.requests.snapshot().results).toHaveLength(0);
  } finally { await h.cleanup(); }
});
test("capability ownership survives an in-memory identity replacement", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); await drain();
    const meta = h.shims[0]!.deliveries[0].meta, token = "f".repeat(64);
    const { payloadHash } = await import("../src/egress");
    h.broker.sessions.get("alpha")!.token_hash = payloadHash(token);
    expect(() => h.broker.tool("alpha", token, "reply", { ...meta, status: "completed", text: "STOLEN" })).toThrow("Delivery ownership mismatch");
    expect(h.broker.requests.snapshot().results).toHaveLength(0);
  } finally { await h.cleanup(); }
});
test("resolving an unknown destination can ask the separate correction question without dropping the task", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); h.say("read tests"); await drain();
    expect(h.live.frames.some(f => f.content.startsWith("Which session?"))).toBe(true);
    h.say("alpha"); await drain();
    expect(h.live.frames.some(f => f.content === "Is that a correction or a new task for alpha?")).toBe(true);
    expect(h.shims[0]!.deliveries).toHaveLength(1);
    h.say("new task"); expect(h.shims[0]!.deliveries.map(d => d.content)).toEqual(["run tests", "read tests"]);
  } finally { await h.cleanup(); }
});
test("explicit correction confirmation can supersede an exported result and retires its voice epoch", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); h.shims[0]!.reply(); await drain();
    h.say("alpha, read tests"); await drain(); expect(h.shims[0]!.deliveries).toHaveLength(1);
    expect(h.live.frames.some(f => f.content === "Is that a correction or a new task for alpha?")).toBe(true);
    h.say("yes, correction"); await drain();
    expect(h.shims[0]!.deliveries).toHaveLength(2);
    expect(h.shims[0]!.deliveries[1].meta.revision).toBe("2");
    expect(h.live.closes).toContain("exported revision retired");
    expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE")).toHaveLength(0);
  } finally { await h.cleanup(); }
});
test("pending route ask preserves a full addressed request and re-asks once after its dispatch", async () => {
  const h = multi();
  try {
    const pending = h.say("New task: step seven"); await drain();
    const request = h.broker.requests.snapshot().delegations.find(d => d.id === pending)!.request_id!;
    h.say("charlie, New task: step eight"); await drain();
    expect(h.shims[2]!.deliveries.map(d => d.content)).toEqual(["New task: step eight"]);
    expect(h.broker.requests.snapshot().requests.find(r => r.id === request)?.state).toBe("WAITING_ROUTE");
    const asks = h.events.filter(e => e.type === "ask" && e.request_id === request);
    expect(asks).toHaveLength(2);
    expect(h.events.indexOf(asks[1])).toBeGreaterThan(h.events.findIndex(e => e.type === "delivered"));
    expect(h.live.frames.filter(f => f.content === "Which session? Live: alpha, bravo, charlie")).toHaveLength(2);
    h.broker.ready("charlie"); h.advance(100); await drain();
    expect(h.events.filter(e => e.type === "ask" && e.request_id === request)).toHaveLength(2);
    h.say("alpha.");
    expect(h.shims[0]!.deliveries.map(d => d.content)).toEqual(["New task: step seven"]);
  } finally { await h.cleanup(); }
});
test("route reminder waits for queued dispatch and disappears if the old ask is cancelled", async () => {
  for (const cancel of [false, true]) {
    const h = multi();
    try {
      h.say("New task: retained"); await drain();
      h.shims[2]!.destroy(); h.say("charlie, New task: queued"); await drain();
      expect(h.events.filter(e => e.type === "ask")).toHaveLength(1);
      if (cancel) h.say("cancel.");
      const reconnect = new Shim(h.broker, "charlie", h.shims[2]!.token); await drain();
      expect(reconnect.deliveries.map(d => d.content)).toEqual(["New task: queued"]);
      expect(h.events.filter(e => e.type === "ask")).toHaveLength(cancel ? 1 : 2);
      expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE")).toHaveLength(cancel ? 0 : 1);
    } finally { await h.cleanup(); }
  }
});
test("bare focused-one and cancel resolve a route ask without extra deliveries", async () => {
  for (const response of ["the focused one", "cancel"]) {
    const h = multi();
    try {
      h.say("New task: retained");
      h.broker.focused = { workspace_ref: "workspace:1", surface_ref: "surface:1" };
      h.say(response);
      expect(h.shims[1]!.deliveries.map(d => d.content)).toEqual(response === "cancel" ? [] : ["New task: retained"]);
      expect(h.broker.requests.snapshot().requests.filter(r => r.state === "WAITING_ROUTE")).toHaveLength(0);
    } finally { await h.cleanup(); }
  }
});
test("expired transport cannot disconnect a relaunched alias with a new token", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests");
    h.advance(6000);
    h.broker.register("alpha", h.root, "a".repeat(64), { workspace_ref: "new", surface_ref: "new" });
    const replacement = new Shim(h.broker, "alpha", "a".repeat(64));
    h.shims[0]!.input({ type: "heartbeat" });
    expect(h.shims[0]!.destroyed).toBe(true);
    expect(h.broker.sessions.get("alpha")?.connected).toBe(true);
    replacement.reply(h.shims[0]!.deliveries[0].meta, "STOLEN");
    expect(replacement.output).toContain('"ok":false');
    expect(h.broker.requests.snapshot().results).toHaveLength(0);
    h.say("alpha, New task: fresh");
    expect(replacement.deliveries.map(d => d.content)).toEqual(["New task: fresh"]);
  } finally { await h.cleanup(); }
});
test("waiting at two seconds and unconfirmed at twenty seconds both pass speech egress", async () => {
  const h = multi();
  try {
    h.say("alpha, run tests"); await drain(); h.live.frames.length = 0;
    const { request_id, revision } = h.shims[0]!.deliveries[0].meta;
    const status = (status: "waiting" | "unconfirmed" | "still_working") => h.broker.actions([
      { type: "append_status", request_id, revision: Number(revision), status, text: "local status" },
    ]);
    h.advance(1100); status("waiting"); await drain(); // 2 s after first fragment
    expect(h.live.frames.filter(f => f.content === "alpha is still working.")).toHaveLength(1);
    h.advance(18000); status("unconfirmed"); await drain(); // 20 s
    expect(h.live.frames.filter(f => f.content === "alpha is still working.")).toHaveLength(2);
    status("still_working"); status("still_working"); await drain();
    expect(h.live.frames.filter(f => f.content === "alpha is still working.")).toHaveLength(3);
  } finally { await h.cleanup(); }
});
test("consumed fragment focus entries are deleted after capture while future fragments still route", async () => {
  const h = multi(), deleted = spyOn(Map.prototype, "delete");
  try {
    h.broker.focused = { workspace_ref: "workspace:1", surface_ref: "surface:0" };
    h.fragment("run tests");
    expect(deleted.mock.calls.some(([key]) => key === 0)).toBe(false);
    h.broker.focused = { workspace_ref: "workspace:1", surface_ref: "surface:1" };
    h.settle();
    expect(deleted.mock.calls.filter(([key]) => key === 0)).toHaveLength(1);
    h.say("read tests");
    expect(deleted.mock.calls.filter(([key]) => key === 1)).toHaveLength(1);
    expect(h.shims[0]!.deliveries.map(d => d.content)).toEqual(["run tests"]);
    expect(h.shims[1]!.deliveries.map(d => d.content)).toEqual(["read tests"]);
  } finally { deleted.mockRestore(); await h.cleanup(); }
});
test("status shows focus on an off session without making it routable", async () => {
  const h = multi();
  try {
    h.broker.focused = { workspace_ref: "workspace:1", surface_ref: "surface:3" };
    expect(h.broker.status().sessions.filter(s => s.focused).map(s => s.alias)).toEqual(["off"]);
    expect(h.broker.sessions.get("off")?.level).toBe("off");
    h.say("run tests");
    expect(h.shims.every(s => s.deliveries.length === 0)).toBe(true);
  } finally { await h.cleanup(); }
});
