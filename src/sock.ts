import { createConnection, createServer, type Socket } from "node:net";
import { chmodSync } from "node:fs";
import { jsonLines, object } from "../shim/protocol";
import type { Broker } from "./broker";
export async function listen(path: string, broker: Broker, controlToken: string) {
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    attachSocket(socket, broker, controlToken);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  return { close: () => new Promise<void>((resolve, reject) => {
    for (const client of clients) client.destroy();
    server.close(error => error ? reject(error) : resolve());
  }) };
}
// Shared by the Unix listener and offline byte-stream tests.
export function attachSocket(socket: Socket, broker: Broker, controlToken: string) {
  let pending = Buffer.alloc(0), mode = "", alias = "", token = "", ended = false;
  let disconnect: (() => void) | undefined;
  socket.on("error", () => {});
  socket.on("close", () => { disconnect?.(); });
  socket.setTimeout(5000, () => { if (!alias) socket.destroy(); });
  const send = (value: unknown) => {
    if (socket.destroyed) throw new Error("Disconnected");
    socket.write(JSON.stringify(value) + "\n");
  };
  const lines = jsonLines(value => {
    if (ended || socket.destroyed) return;
    try {
      if (!object(value)) throw new Error("Invalid command");
      if (!alias) {
        if (value.type === "connect" && typeof value.alias === "string" && typeof value.token === "string") {
          alias = value.alias; token = value.token;
          disconnect = broker.connect(alias, token, send); send({ ok: true }); return;
        }
        if (value.type !== "control" || value.token !== controlToken || typeof value.command !== "string") throw new Error("Unauthorized");
        let result: unknown = {};
        switch (value.command) {
          case "register":
            if (typeof value.alias !== "string" || typeof value.cwd !== "string" || typeof value.capability !== "string") throw new Error("Invalid registration");
            broker.register(value.alias, value.cwd, value.capability); break;
          case "status": result = broker.status(); break;
          case "usage": result = broker.ledger.snapshot(); break;
          case "wake": broker.wake(); break;
          case "sleep": void broker.live.close("sleep"); break;
          default: send({ ok: false, error: "Unknown control" }); ended = true; socket.end(); return;
        }
        send({ ok: true, result }); ended = true; socket.end(); return;
      }
      if (!broker.authenticate(alias, token)) throw new Error("Unauthorized session");
      if (value.type === "channel_ready") broker.ready(alias);
      else if (value.type === "channel_initialize") { /* P0 protocol negotiation remains in the shim. */ }
      else if (value.type === "tool_call") {
        try { broker.tool(alias, token, value.name, value.arguments); }
        catch { send({ ok: false, call_id: value.call_id, error: "Command rejected" }); return; }
      }
      else throw new Error("Unknown channel command");
      send({ ok: true, call_id: value.call_id });
    } catch { if (!socket.destroyed) send({ ok: false, error: "Command rejected" }); ended = true; socket.end(); }
  }, () => socket.destroy());
  socket.on("data", bytes => {
    if (ended || socket.destroyed) return;
    if (mode === "lines") { lines(bytes); return; }
    pending = Buffer.concat([pending, bytes]);
    if (pending.length > 1_048_576) { socket.destroy(); return; }
    if (!mode && pending.length >= 5) mode = pending.subarray(0, 5).toString() === "POST " ? "http" : "lines";
    if (mode === "lines") { lines(pending); pending = Buffer.alloc(0); return; }
    const split = pending.indexOf("\r\n\r\n");
    if (split < 0) return;
    try {
      const header = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, split));
      if (!header.startsWith("POST /hook HTTP/1.1\r\n") || /transfer-encoding:/i.test(header)) throw new Error("Invalid HTTP");
      const sizes = [...header.matchAll(/\r\ncontent-length:\s*(\d+)\s*(?=\r\n|$)/gi)];
      if (sizes.length !== 1) throw new Error("Invalid length");
      const size = Number(sizes[0]![1]);
      if (size > 65536) throw new Error("Oversized hook");
      if (pending.length < split + 4 + size) return;
      const alias = header.match(/\r\nx-hotmic-alias:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "";
      const token = header.match(/\r\nx-hotmic-token:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "";
      broker.hook(alias, token, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(split + 4, split + 4 + size))));
      ended = true;
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    } catch { ended = true; socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"); }
  });
}

export function control(path: string, token: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => socket.destroy(new Error("Broker timed out")), 3000);
    let settled = false;
    socket.on("error", reject);
    socket.on("close", () => { clearTimeout(timer); if (!settled) reject(new Error("Broker disconnected")); });
    socket.on("connect", () => socket.write(JSON.stringify({ ...args, type: "control", command, token }) + "\n"));
    socket.on("data", jsonLines(value => {
      settled = true;
      if (object(value) && value.ok === true) resolve(value.result); else reject(new Error("Broker rejected command"));
      socket.end();
    }, () => socket.destroy(new Error("Invalid broker response"))));
  });
}
