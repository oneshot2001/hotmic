import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import { attachSocket } from "../src/sock";
import { harness, drain, FakeTTY } from "./p2-helpers";
import { serveTerminal } from "../src/terminal";
class MemorySocket extends EventEmitter {
  destroyed = false;
  output = "";
  setTimeout() { return this; }
  write(bytes: string) { this.output += bytes; return true; }
  end(bytes = "") { this.write(bytes); this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
  input(bytes: Buffer) { if (!this.destroyed) this.emit("data", bytes); }
}
function connection(h: ReturnType<typeof harness>) {
  const socket = new MemorySocket(); attachSocket(socket as unknown as Socket, h.broker, "owner"); return socket;
}
test("production socket handler checks tokens, forged aliases and control separation", async () => {
  const h = harness(); h.broker.sessions.get("sandbox")!.send = undefined;
  try {
    for (const value of [{ type: "connect", alias: "sandbox", token: "wrong" }, { type: "connect", alias: "other", token: h.token },
      { type: "control", command: "approve", token: h.token }]) {
      const socket = connection(h); socket.input(Buffer.from(JSON.stringify(value) + "\n")); expect(socket.output).toContain('"ok":false');
      expect(socket.destroyed).toBe(true);
    }
    const socket = connection(h);
    socket.input(Buffer.from(JSON.stringify({ type: "connect", alias: "sandbox", token: h.token }) + "\n"));
    expect(socket.output).toContain('"ok":true');
    socket.input(Buffer.from(JSON.stringify({ type: "tool_call", name: "reply", arguments: { request_id: "fake", revision: "1", delivery_id: "fake", session_alias: "other", status: "completed", text: "CANARY" } }) + "\n"));
    expect(socket.output).toContain('"ok":false'); await drain(); expect(JSON.stringify(h.live.frames)).not.toContain("CANARY");
  } finally { h.cleanup(); }
});
test("control capability cannot approve or reject and status never exposes approval hashes", async () => {
  const h = harness();
  const terminal = serveTerminal(h.broker, new FakeTTY(), () => {});
  try {
    const meta = h.request();
    h.broker.tool("sandbox", h.token, "reply", { ...meta, status: "completed", text: "LOCAL ONLY" }); await drain();
    const pending = h.broker.pending()[0]!;
    for (const command of ["approve", "reject"]) {
      const socket = connection(h);
      socket.input(Buffer.from(JSON.stringify({ ...pending, type: "control", token: "owner", command }) + "\n"));
      await drain();
      expect(JSON.parse(socket.output)).toEqual({ ok: false, error: "Unknown control" });
      expect(socket.destroyed).toBe(true);
      expect(h.broker.pending()).toEqual([pending]);
    }
    const socket = connection(h);
    socket.input(Buffer.from(JSON.stringify({ type: "control", token: "owner", command: "status" }) + "\n"));
    const status = JSON.parse(socket.output).result;
    expect(status.pending).toHaveLength(1);
    expect(status.pending[0]).not.toHaveProperty("hash");
    expect(socket.output).not.toContain(pending.hash);
    expect(status.approval).toBe("TTY keystroke only");
    await drain(); expect(JSON.stringify(h.live.frames)).not.toContain("LOCAL ONLY");
  } finally { terminal.close(); await drain(); h.cleanup(); }
});
test("authenticated tool rejections retain call IDs and allow retry on the same channel", async () => {
  const h = harness("summary");
  try {
    const meta = h.request(); await drain(); h.live.frames.length = 0;
    h.broker.sessions.get("sandbox")!.send = undefined;
    const socket = connection(h);
    const send = (value: unknown) => socket.input(Buffer.from(JSON.stringify(value) + "\n"));
    send({ type: "connect", alias: "sandbox", token: h.token });
    for (const [i, args] of [{ ...meta, revision: 1 }, { ...meta, session_alias: "other" }, { ...meta, delivery_id: "forged" }].entries()) {
      send({ type: "tool_call", call_id: "bad-" + i, name: "acknowledge", arguments: args });
      expect(JSON.parse(socket.output.trim().split("\n").at(-1)!)).toEqual({ ok: false, call_id: "bad-" + i, error: "Command rejected" });
      expect(socket.destroyed).toBe(false);
      expect(h.broker.sessions.get("sandbox")!.send).toBeDefined();
    }
    send({ type: "tool_call", call_id: "retry", name: "reply", arguments: { ...meta, status: "completed", text: "Valid retry" } });
    await drain();
    expect(JSON.parse(socket.output.trim().split("\n").at(-1)!)).toEqual({ ok: true, call_id: "retry" });
    expect(h.live.frames.map(f => f.content)).toEqual(["sandbox: Valid retry"]);
    socket.destroy();
  } finally { h.cleanup(); }
});
test("malformed framing closes an authenticated channel before subsequent valid calls", async () => {
  for (const malformed of [Buffer.from("not json\n"), Buffer.from([123, 34, 0xff, 0xff, 10]), Buffer.alloc(1_048_577, 65)]) {
    const h = harness("summary");
    try {
      const meta = h.request(); await drain(); h.live.frames.length = 0;
      h.broker.sessions.get("sandbox")!.send = undefined;
      const socket = connection(h);
      socket.input(Buffer.from(JSON.stringify({ type: "connect", alias: "sandbox", token: h.token }) + "\n"));
      const reply = Buffer.from(JSON.stringify({ type: "tool_call", call_id: "late", name: "reply", arguments: { ...meta, status: "completed", text: "CANARY" } }) + "\n");
      socket.input(Buffer.concat([malformed, reply]));
      expect(socket.destroyed).toBe(true);
      expect(h.broker.sessions.get("sandbox")!.send).toBeUndefined();
      await drain(); expect(h.live.frames.map(f => f.content)).toEqual(["sandbox is not responding"]);
      expect(h.broker.requests.snapshot().results).toEqual([]);
    } finally { h.cleanup(); }
  }
});
test("revoked channel authentication closes instead of treating it as a recoverable tool rejection", async () => {
  const h = harness();
  try {
    const meta = h.request(); await drain();
    h.broker.sessions.get("sandbox")!.send = undefined;
    const socket = connection(h);
    socket.input(Buffer.from(JSON.stringify({ type: "connect", alias: "sandbox", token: h.token }) + "\n"));
    h.broker.sessions.get("sandbox")!.token_hash = "b".repeat(64);
    socket.input(Buffer.from(JSON.stringify({ type: "tool_call", call_id: "revoked", name: "acknowledge", arguments: meta }) + "\n"));
    expect(socket.destroyed).toBe(true);
    expect(JSON.parse(socket.output.trim().split("\n").at(-1)!)).toEqual({ ok: false, error: "Command rejected" });
    expect(h.broker.sessions.get("sandbox")!.send).toBeUndefined();
  } finally { h.cleanup(); }
});
test("hook POST arbitrary byte boundaries, metadata-only filtering, missing credentials rejected", async () => {
  const h = harness("status");
  try {
    h.request(); await drain(); h.live.frames.length = 0;
    const post = (token: string) => {
      const body = JSON.stringify({ hook_event_name: "Stop", session_id: "s", prompt: "CANARY🍋", last_assistant_message: "CANARY🍋" });
      return Buffer.from(`POST /hook HTTP/1.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Hotmic-Alias: sandbox\r\nX-Hotmic-Token: ${token}\r\n\r\n${body}`);
    };
    const wrong = connection(h); wrong.input(post("wrong")); expect(wrong.output).toContain("403 Forbidden");
    const bytes = post(h.token);
    for (let i = 1; i < bytes.length; i++) {
      const socket = connection(h); socket.input(bytes.subarray(0, i)); expect(socket.output).toBe("");
      socket.input(bytes.subarray(i)); expect(socket.output).toContain("200 OK");
    }
    h.advance(3000); await drain();
    expect(h.live.frames.map(f => f.content)).toEqual(["sandbox has a result ready in the terminal."]);
    expect(JSON.stringify(h.events)).not.toContain("CANARY");
  } finally { h.cleanup(); }
});
test("malformed UTF-8 and oversized lines close before processing", () => {
  const h = harness();
  try {
    const socket = connection(h); socket.input(Buffer.from([123, 34, 0xff, 0xff, 10])); expect(socket.destroyed).toBe(true);
    const big = connection(h); big.input(Buffer.alloc(1_048_577, 65)); expect(big.destroyed).toBe(true);
  } finally { h.cleanup(); }
});
test("broker-down hook exits zero and emits empty object; malformed input also safe", async () => {
  for (const body of [JSON.stringify({ hook_event_name: "Stop", session_id: "s" }), "not json"]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../shim/hook.ts"), "/tmp/hotmic-nonexistent-p2.sock"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(body); child.stdin.end();
    expect(await new Response(child.stdout).text()).toBe("{}\n"); expect(await child.exited).toBe(0);
  }
});
test("reply JSON split at every byte is assembled before any secret can reach egress", async () => {
  const h = harness("summary");
  try {
    const meta = h.request(); await drain(); h.live.frames.length = 0;
    h.broker.sessions.get("sandbox")!.send = undefined;
    const socket = connection(h);
    socket.input(Buffer.from(JSON.stringify({ type: "connect", alias: "sandbox", token: h.token }) + "\n"));
    const bytes = Buffer.from(JSON.stringify({ type: "tool_call", call_id: "test", name: "reply", arguments: { ...meta, status: "completed", text: "Result 🍋 sk-proj-secretcredential" } }) + "\n");
    for (let i = 0; i < bytes.length - 1; i++) {
      socket.input(bytes.subarray(i, i + 1)); expect(h.live.frames).toHaveLength(0);
    }
    socket.input(bytes.subarray(-1)); await drain();
    expect(h.live.frames.map(f => f.content)).toEqual(["sandbox: Result 🍋 [redacted]"]);
    expect(socket.output).toContain('"call_id":"test"'); socket.destroy();
  } finally { h.cleanup(); }
});
