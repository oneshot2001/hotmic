import { createConnection } from "node:net";
import { identity, identityProperties, jsonLines, object, validTool } from "./protocol";

// Temporary allowlist until the probe captures the client version for P2.
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-11-25"] as const;
export const PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export const channelTools = ["acknowledge", "reply"].map((name) => ({
  name,
  description: name === "acknowledge" ? "Acknowledge a channel delivery using its metadata."
    : "Return the result of a channel delivery using its metadata, status, and text.",
  inputSchema: {
    type: "object",
    properties: { ...identityProperties, ...(name === "reply" ? {
      status: { type: "string", enum: ["completed", "failed", "question"] },
      text: { type: "string" },
    } : {}) },
    required: [...Object.keys(identityProperties), ...(name === "reply" ? ["status", "text"] : [])],
    additionalProperties: false,
  },
}));

export async function serveChannel(
  input: ReadableStream<Uint8Array>,
  output: (line: string) => void,
  forward: (value: unknown) => Promise<void>,
) {
  const send = (value: unknown) => output(JSON.stringify(value) + "\n");
  let queue = Promise.resolve();
  const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const read = jsonLines((value) => {
    queue = queue.then(async () => {
      if (!object(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
        error(null, -32600, "Invalid request"); return;
      }
      const { id, method, params } = value;
      if (id === undefined) {
        if (method === "notifications/initialized") await forward({ type: "channel_ready" });
        return;
      }
      if (typeof id !== "string" && typeof id !== "number") { error(null, -32600, "Invalid id"); return; }
      let result: unknown;
      if (method === "initialize") {
        if (object(params) && typeof params.protocolVersion === "string")
          await forward({ type: "channel_initialize", protocolVersion: params.protocolVersion });
        if (!object(params) || !PROTOCOL_VERSIONS.some((version) => version === params.protocolVersion)) { error(id, -32602, "Unsupported protocolVersion"); return; }
        result = {
          protocolVersion: params.protocolVersion,
          capabilities: { experimental: { "claude/channel": {} }, tools: {} },
          serverInfo: { name: "hotmic", version: "0.0.0" },
          instructions: "For each hotmic channel notification, call acknowledge with its metadata, then reply with the same metadata, status, and result text.",
        };
      } else if (method === "ping") result = {};
      else if (method === "tools/list") result = { tools: channelTools };
      else if (method === "tools/call") {
        if (!object(params) || !validTool(params.name, params.arguments)) { error(id, -32602, "Invalid tool or arguments"); return; }
        try {
          await forward({ type: "tool_call", name: params.name, arguments: params.arguments });
          result = { content: [{ type: "text", text: "Forwarded to hotmic." }] };
        } catch {
          result = { isError: true, content: [{ type: "text", text: "hotmic socket unavailable" }] };
        }
      } else { error(id, -32601, "Method not found"); return; }
      send({ jsonrpc: "2.0", id, result });
    });
  }, () => error(null, -32700, "Parse error"));
  for await (const bytes of input) { read(bytes); await queue; }
}

async function main() {
  const path = process.env.HOTMIC_SOCK;
  if (!path) throw new Error("HOTMIC_SOCK is required");
  const socket = createConnection(path);
  socket.on("error", () => { console.error("hotmic socket failed"); process.exitCode = 1; });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.on("data", jsonLines((value) => {
    if (!object(value) || typeof value.content !== "string" || !identity(value.meta)) {
      console.error("Invalid channel notification"); return;
    }
    const metadata = value.meta;
    const meta = Object.fromEntries(Object.keys(identityProperties).map((key) => [key, String(metadata[key])]));
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/claude/channel", params: { content: value.content, meta } }) + "\n");
  }, () => console.error("Invalid socket JSON")));
  try {
    await serveChannel(Bun.stdin.stream(), (line) => { process.stdout.write(line); }, (value) =>
      new Promise<void>((resolve, reject) => {
        socket.write(JSON.stringify(value) + "\n", (error) => error ? reject(error) : resolve());
      }));
  } finally { socket.destroy(); }
}

if (import.meta.main) main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
