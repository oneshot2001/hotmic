import { test, expect, spyOn } from "bun:test";
import { currentRequest } from "../src/requests";
import { drain, harness, FakeTTY } from "./p2-helpers";
import { serveTerminal } from "../src/terminal";
test("fake live + shim: delegation/transcripts settle, deliver, ack, reply, release approval", async () => {
  const h = harness();
  const tty = new FakeTTY(), terminal = serveTerminal(h.broker, tty, () => {});
  try {
    h.broker.event({ type: "session.input_transcript.delta", start_ms: 0, end_ms: 1000, delta: "New task: test" });
    h.broker.event({ type: "local.silence", silent: true });
    h.broker.event({ type: "session.delegation.created", delegation: { id: "voice-d1" }, offset_ms: 1000 });
    h.advance(899); expect(h.deliveries).toHaveLength(0);
    h.advance(1); expect(h.deliveries).toHaveLength(1);
    const meta = h.deliveries[0].meta;
    h.broker.tool("sandbox", h.token, "acknowledge", meta);
    expect(currentRequest(h.broker.requests.snapshot(), meta.request_id)?.state).toBe("ACKNOWLEDGED");
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "Done safely" });
    await drain();
    expect(h.live.frames.some(f => f.content.includes("Done safely"))).toBe(false);
    const pending = h.broker.pending()[0]!;
    terminal.render(); tty.key("a"); await drain();
    expect(h.live.frames.filter(f => f.content === "sandbox: Done safely")).toHaveLength(1);
    expect(currentRequest(h.broker.requests.snapshot(), meta.request_id)?.state).toBe("RESULT_AVAILABLE");
    expect(() => h.broker.approve(pending.hash, pending.request_id, pending.revision)).toThrow();
  } finally { terminal.close(); h.cleanup(); }
});
test("summary auto exports once, rejects forged alias, cross-session IDs and token", async () => {
  const h = harness("summary");
  try {
    const meta = h.request();
    for (const args of [{ ...meta, session_alias: "other" }, { ...meta, request_id: "different" }, { ...meta, revision: "2" }]) {
      expect(() => h.broker.tool("sandbox", h.token, "reply", { ...args, status: "completed", text: "FORGED" })).toThrow();
    }
    expect(() => h.broker.tool("other", h.token, "reply", { ...meta, status: "completed", text: "FORGED" })).toThrow();
    expect(() => h.broker.tool("sandbox", "wrong", "acknowledge", meta)).toThrow();
    const reply = { ...meta, status: "completed", text: "Safe answer" };
    h.broker.tool("sandbox", h.token, "reply", reply); h.broker.tool("sandbox", h.token, "reply", reply); await drain();
    expect(h.live.frames.filter(f => f.content === "sandbox: Safe answer")).toHaveLength(1);
    expect(JSON.stringify(h.live.frames)).not.toContain("FORGED");
  } finally { h.cleanup(); }
});
test("hook canary stays local, Stop fallback emits a template only once", async () => {
  const h = harness("status");
  try {
    const meta = h.request(); await drain(); h.live.frames.length = 0;
    h.broker.hook("sandbox", h.token, { session_id: "CANARY-secret", hook_event_name: "Stop", last_assistant_message: "CANARY-secret", tool_name: "CANARY-secret" });
    h.advance(2999); await drain(); expect(h.live.frames).toHaveLength(0);
    h.advance(1); await drain();
    expect(h.live.frames.map(f => f.content)).toEqual(["sandbox has a result ready in the terminal."]);
    h.advance(1); await drain(); expect(h.live.frames).toHaveLength(1);
    expect(JSON.stringify(h.events)).not.toContain("CANARY-secret");
    expect(h.broker.requests.snapshot().results).toHaveLength(0);
    expect(meta.session_alias).toBe("sandbox");
  } finally { h.cleanup(); }
});
test("release reject and supersede invalidate exact approval, old tool replies cannot leak", async () => {
  const h = harness();
  const terminal = serveTerminal(h.broker, new FakeTTY(), () => {});
  try {
    const meta = h.request();
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "OLD CANARY" }); await drain();
    const p = h.broker.pending()[0]!;
    h.broker.live.egress.approve(p.hash, p.request_id, p.revision);
    h.broker.reject(p.request_id, p.revision); await h.broker.export(p.request_id, p.revision);
    expect(() => h.broker.approve(p.hash, p.request_id, p.revision)).toThrow();
    h.request("d2", "Actually, replace that with tests"); await drain();
    expect(currentRequest(h.broker.requests.snapshot(), p.request_id)?.revision).toBe(2);
    expect(h.deliveries.at(-1).content).toContain("Correction replacing");
    expect(() => h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "OLD CANARY" })).toThrow();
    expect(JSON.stringify(h.live.frames)).not.toContain("OLD CANARY");
  } finally { terminal.close(); h.cleanup(); }
});
test("sleep queues result; next explicit wake exports only authorized result", async () => {
  const h = harness("summary");
  try {
    const meta = h.request(); await drain();
    await h.live.close("sleep"); h.broker.event({ type: "transport.closed" });
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "Queued answer" }); await drain();
    expect(h.live.frames.some(f => f.content.includes("Queued"))).toBe(false);
    h.broker.wake(); h.broker.event({ type: "session.started" }); await drain();
    expect(h.live.frames.filter(f => f.content.includes("Queued"))).toHaveLength(1);
    expect(h.live.frames.at(-1)?.delegation_id).toBeNull();
  } finally { h.cleanup(); }
});
test("off destination generates ask locally and sends no session bytes", async () => {
  const h = harness("off");
  try {
    h.broker.event({ type: "session.input_transcript.delta", start_ms: 0, end_ms: 1, delta: "test" });
    h.broker.event({ type: "local.silence", silent: true });
    h.broker.event({ type: "session.delegation.created", delegation: { id: "off" }, offset_ms: 1 });
    h.advance(900); await drain();
    expect(h.events.some(e => e.type === "ask" && e.text === "That session is not available by voice.")).toBe(true);
    expect(h.deliveries).toHaveLength(0); expect(h.live.frames).toHaveLength(0);
  } finally { h.cleanup(); }
});
test("usage snapshots replace, final close finalizes, cancel after append closes voice", async () => {
  const h = harness("summary");
  try {
    const meta = h.request();
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "answer" }); await drain();
    h.broker.handle({ type: "cancel", request_id: meta.request_id, revision: 1 });
    expect(h.live.closes).toContain("exported revision retired");
    h.broker.event({ type: "session.usage.updated", usage: { seconds: 96 } });
    h.broker.event({ type: "session.usage.updated", usage: { seconds: 96 } });
    h.broker.event({ type: "session.closed", usage: { seconds: 96 } });
    expect(h.broker.ledger.snapshot()[0]?.usd).toBeCloseTo(0.08);
    expect(h.broker.ledger.snapshot()[0]?.finalized).toBe(1);
  } finally { h.cleanup(); }
});
test("replacement capability cannot claim a delivery owned by the previous channel", async () => {
  const h = harness("summary");
  try {
    const old = h.request(); await drain(); h.live.frames.length = 0;
    h.broker.sessions.get("sandbox")!.send = undefined;
    const replacement = "b".repeat(64);
    h.broker.register("sandbox", h.root, replacement);
    h.broker.connect("sandbox", replacement, value => h.deliveries.push(value));
    expect(h.broker.authenticate("sandbox", replacement)).toBe(true);
    for (const name of ["acknowledge", "reply"]) {
      const args = name === "reply" ? { ...old, status: "completed", text: "STOLEN" } : old;
      expect(() => h.broker.tool("sandbox", replacement, name, args)).toThrow("Delivery ownership mismatch");
    }
    await drain(); expect(h.broker.requests.snapshot().results).toEqual([]); expect(h.live.frames).toEqual([]);
    const fresh = h.request("d2");
    h.broker.tool("sandbox", replacement, "reply", { ...fresh, status: "completed", text: "Owned result" }); await drain();
    expect(h.live.frames.some(f => f.content === "sandbox: Owned result")).toBe(true);
  } finally { h.cleanup(); }
});
test("delivery reads policy once for a consistent authorization decision", () => {
  const h = harness();
  const policy = spyOn(h.options, "policy");
  try {
    h.live.awake = false;
    h.request();
    expect(h.deliveries).toHaveLength(1);
    expect(policy).toHaveBeenCalledTimes(1);
  } finally { policy.mockRestore(); h.cleanup(); }
});
test("export takes one context snapshot per authorization check", async () => {
  const h = harness("summary");
  const meta = h.request(); await drain();
  const context = spyOn(h.broker, "context");
  try {
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "One chunk" }); await drain();
    expect(h.live.frames.at(-1)?.content).toBe("sandbox: One chunk");
    // Initial identity, initial authorization, then authorization before the chunk.
    expect(context).toHaveBeenCalledTimes(3);
  } finally { context.mockRestore(); h.cleanup(); }
});
