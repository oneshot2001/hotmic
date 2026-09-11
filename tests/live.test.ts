import { test, expect } from "bun:test";
import { Live } from "../src/live";
import { type Context } from "../src/egress";
import { sandbox, drain } from "./p2-helpers";
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  frames: Record<string, any>[] = [];
  send(text: string) { this.frames.push(JSON.parse(text)); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  terminate() { this.close(); }
  incoming(event: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
}
test("Live starts with P0 contract, matches append ack by client_event_id and closes with final usage", async () => {
  const f = sandbox("summary"), socket = new FakeSocket(), events: Record<string, unknown>[] = [], audit: Record<string, unknown>[] = [];
  let audioStarts = 0, audioStops = 0;
  const live = new Live({ key: "test-only", socket: () => socket as unknown as WebSocket, event: e => events.push(e), audit: e => audit.push(e),
    audio: () => ({ start: () => { audioStarts++; }, output: () => {}, stop: () => { audioStops++; } }) });
  try {
    live.wake(); expect(audioStarts).toBe(0); socket.dispatchEvent(new Event("open"));
    const start = socket.frames[0]!;
    expect(start.type).toBe("session.start"); expect(start.session.store).toBe(false);
    expect(start.session.delegation).toEqual({ type: "client" }); expect(start.session.audio.format.rate).toBe(24000);
    expect(start.session.instructions).toContain("ALLOWED acknowledgement phrases");
    socket.incoming({ type: "session.started" }); expect(audioStarts).toBe(1);
    const ctx: Context = { request_id: "r", revision: 1, session_alias: "sandbox", cwd: f.root, policy: f.policy, secrets: [], current: true, source: "reply" };
    let finished = false;
    const sending = live.egress.emit("commentary", "safe", "sandbox", () => ctx).then(() => { finished = true; });
    const frame = socket.frames.at(-1)!;
    expect(frame.type).toBe("session.commentary.append"); expect(frame.delegation_id).toBeNull();
    socket.incoming({ type: "session.commentary.appended", client_event_id: "wrong" }); await drain(); expect(finished).toBe(false);
    socket.incoming({ type: "session.thinking.appended", client_event_id: frame.event_id }); await drain(); expect(finished).toBe(false);
    socket.incoming({ type: "session.commentary.appended", client_event_id: frame.event_id }); await sending;
    const closing = live.close("sleep"); expect(socket.frames.at(-1)?.type).toBe("session.close");
    socket.incoming({ type: "session.closed", usage: { seconds: 96 } }); await closing;
    expect(live.awake).toBe(false); expect(audioStops).toBeGreaterThan(0);
    expect(events.some(e => e.type === "session.closed")).toBe(true);
    expect(audit.filter(e => e.type === "outbound")).toHaveLength(1);
    expect("appendRaw" in live).toBe(false);
  } finally { socket.close(); f.cleanup(); }
});
test("Live rejects pending append on server error without logging error content", async () => {
  const f = sandbox("summary"), socket = new FakeSocket(), audit: Record<string, unknown>[] = [];
  const live = new Live({ key: "test", socket: () => socket as unknown as WebSocket, event: () => {}, audit: e => audit.push(e), audio: () => ({ start() {}, output() {}, stop() {} }) });
  try {
    live.wake(); socket.dispatchEvent(new Event("open")); socket.incoming({ type: "session.started" });
    const sending = live.egress.emit("commentary", "safe", "sandbox", () => ({ request_id: "r", revision: 1, session_alias: "sandbox", cwd: f.root, policy: f.policy, secrets: [], current: true, source: "reply" }));
    socket.incoming({ type: "error", client_event_id: socket.frames.at(-1)!.event_id, message: "secret server echo" });
    await expect(sending).rejects.toThrow("Append not confirmed"); expect(JSON.stringify(audit)).not.toContain("secret server echo"); socket.close();
  } finally { socket.close(); f.cleanup(); }
});
