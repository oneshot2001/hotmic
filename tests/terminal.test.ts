import { test, expect, spyOn } from "bun:test";
import { serveTerminal } from "../src/terminal";
import { drain, harness, FakeTTY } from "./p2-helpers";

test("serve raw TTY approves only the displayed exact payload and keeps its hash in memory", async () => {
  const h = harness(), tty = new FakeTTY(), output: string[] = [];
  const terminal = serveTerminal(h.broker, tty, line => output.push(line));
  try {
    expect(tty.isRaw).toBe(true); expect(tty.resumed).toBe(true);
    expect(h.broker.status().approval).toBe("TTY keystroke only");
    const meta = h.request();
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "Approved result" }); await drain();
    const p = h.broker.pending()[0]!;
    tty.key("a"); await drain();
    expect(h.live.frames.some(f => f.content === p.text)).toBe(false);
    terminal.render();
    expect(output.join("\n")).toContain(JSON.stringify(p.text));
    expect(output.join("\n")).not.toContain(p.hash);
    tty.key("a\n"); await drain();
    expect(h.live.frames.some(f => f.content === p.text)).toBe(false);
    tty.key("a"); await drain();
    expect(h.live.frames.filter(f => f.content === p.text)).toHaveLength(1);
    expect(JSON.stringify(h.events)).not.toContain(p.hash);
    expect(h.events.some(e => e.type === "approved")).toBe(true);
    terminal.close();
    expect(tty.isRaw).toBe(false); expect(tty.resumed).toBe(false);
    expect(tty.listenerCount("data")).toBe(0);
    expect(h.broker.status().approval).toBe("unavailable (serve has no TTY)");
  } finally { terminal.close(); h.cleanup(); }
});
test("non-TTY serve never accepts piped approval and advertises that release is held", async () => {
  const h = harness(), input = new FakeTTY(), output: string[] = [];
  input.isTTY = false;
  const terminal = serveTerminal(h.broker, input, line => output.push(line));
  try {
    const meta = h.request();
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "Held result" }); await drain();
    const p = h.broker.pending()[0]!;
    terminal.render(); input.key("a"); input.key("r"); await drain();
    expect(input.isRaw).toBe(false); expect(input.listenerCount("data")).toBe(0);
    expect(output.join("\n")).toContain("Release held: serve requires a TTY.");
    expect(output.join("\n")).not.toContain("[a]pprove");
    expect(() => h.broker.approve(p.hash, p.request_id, p.revision)).toThrow("Approval requires serve TTY");
    expect(h.broker.pending()).toEqual([p]);
    expect(h.live.frames.some(f => f.content === p.text)).toBe(false);
  } finally { terminal.close(); h.cleanup(); }
});
test("TTY approval cannot follow an unseen revision; rejection uses the displayed reference", async () => {
  const h = harness(), tty = new FakeTTY(), output: string[] = [];
  const terminal = serveTerminal(h.broker, tty, line => output.push(line));
  try {
    const meta = h.request();
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "Old result" }); await drain();
    terminal.render();
    const revised = h.request("d2", "Actually, replace that with tests");
    h.broker.tool("sandbox", h.token, "reply", { ...revised, status: "completed", text: "Unseen result" }); await drain();
    tty.key("a"); await drain();
    expect(output.at(-1)).toBe("Approval expired; review the current payload.");
    expect(h.live.frames.some(f => f.content.includes("result"))).toBe(false);
    expect(h.broker.pending()).toHaveLength(1);
    terminal.render(); tty.key("r"); await drain();
    expect(h.broker.pending()).toEqual([]);
    expect(h.events.some(e => e.type === "rejected" && e.revision === 2)).toBe(true);
    tty.key("a"); await drain();
    expect(h.live.frames.some(f => f.content.includes("result"))).toBe(false);
  } finally { terminal.close(); h.cleanup(); }
});
test("pane rendering leaves the status snapshot order untouched", () => {
  const h = harness(), tty = new FakeTTY();
  const terminal = serveTerminal(h.broker, tty, () => {});
  const snapshot = h.broker.status();
  const base = h.request();
  const request = h.broker.status().requests[0]!;
  snapshot.requests = Object.freeze([{ ...request, id: base.request_id, updated_at: 1 }, { ...request, id: "newer", updated_at: 2 }]) as typeof snapshot.requests;
  const status = spyOn(h.broker, "status").mockReturnValue(snapshot);
  try {
    expect(() => terminal.render()).not.toThrow();
    expect(snapshot.requests.map(r => r.updated_at)).toEqual([1, 2]);
  } finally { status.mockRestore(); terminal.close(); h.cleanup(); }
});
