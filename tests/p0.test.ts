import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordChannelEvent } from "../scripts/channel-artifact";
import { describe, expect, test } from "bun:test";
import { audioLimits, chunkFrames, costUSD, FRAME_BYTES, rms, silenceFrame, transcriptWords } from "../src/p0-audio";
import { PROTOCOL_VERSION, serveChannel } from "../shim/channel";
import { hookMetadata } from "../shim/hook";
import { jsonLines } from "../shim/protocol";

describe("PCM frames and silence", () => {
  test("arbitrary chunks preserve every byte across 960-byte boundaries", () => {
    const input = Buffer.from(Array.from({ length: FRAME_BYTES * 3 + 11 }, (_, i) => i % 256));
    for (const chunkSize of [1, 7, 959, 960, 961, 2048, input.length]) {
      let pending = Buffer.alloc(0);
      const frames: Buffer[] = [];
      for (let offset = 0; offset < input.length; offset += chunkSize) {
        const result = chunkFrames(pending, input.subarray(offset, offset + chunkSize));
        frames.push(...result.frames); pending = result.pending;
      }
      expect(frames.map((frame) => frame.length)).toEqual([960, 960, 960]);
      expect(pending.length).toBe(11);
      expect(Buffer.concat([...frames, pending])).toEqual(input);
    }
  });
  test("synthetic signal RMS and 300ms continuous silence, reset by speech", () => {
    const signal = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < signal.length / 2; i++) signal.writeInt16LE(Math.round(16384 * Math.sin(2 * Math.PI * i / 24)), i * 2);
    expect(rms(signal)).toBeCloseTo(0.5 / Math.sqrt(2), 4);
    expect(rms(Buffer.alloc(960))).toBe(0);
    let since: number | null = null;
    for (let at = 20; at <= 300; at += 20) {
      const state = silenceFrame(since, 0, at); since = state.since;
      expect(state.silent).toBe(at === 300);
    }
    expect(silenceFrame(since, rms(signal), 320)).toEqual({ since: null, silent: false });
    expect(silenceFrame(null, 0, 340)).toEqual({ since: 320, silent: false });
  });
});

test("96 seconds costs $0.08; caps reserve close time", () => {
  expect(costUSD(96)).toBeCloseTo(0.08, 10);
  expect(costUSD(0)).toBe(0);
  expect(audioLimits(90, 0.15)).toEqual({ hardSeconds: 90, captureSeconds: 79 });
  expect(audioLimits(300, 0.15).hardSeconds).toBeCloseTo(180);
  expect(() => audioLimits(NaN, 0.15)).toThrow();
  expect(() => audioLimits(90, -1)).toThrow();
  expect(() => audioLimits(90, 0.001)).toThrow();
  expect(() => costUSD(-1)).toThrow();
});

test("echo word assembly preserves split words", () => {
  expect(transcriptWords("", "hel")).toEqual({ words: [], pending: "hel" });
  expect(transcriptWords("hel", "lo world ")).toEqual({ words: ["hello", "world"], pending: "" });
});

test("metadata allowlist drops text, paths, nested values, and unknown hook operations", () => {
  const metadata = { session_id: "s1", hook_event_name: "Stop", tool_name: "Read", turn_id: "t1", message_id: "m1", tool_use_id: "u1" };
  expect(hookMetadata({ ...metadata, prompt: "SECRET", delta: "SECRET", last_assistant_message: "SECRET", transcript_path: "/SECRET", tool_input: { path: "/SECRET" }, tool_response: "SECRET", surprise: "SECRET" })).toEqual(metadata);
  expect(() => hookMetadata({ ...metadata, hook_event_name: "MessageDisplay" })).toThrow();
  expect(() => hookMetadata({ ...metadata, hook_event_name: ["Stop"] })).toThrow();
  expect(() => hookMetadata({ ...metadata, session_id: {} })).toThrow();
});

async function roundTrip(input: string, fragmentSize = 1) {
  const pipe = new TransformStream<Uint8Array, Uint8Array>();
  const output: unknown[] = [];
  const forwarded: unknown[] = [];
  const read = jsonLines((value) => output.push(value), () => { throw new Error("Invalid server output"); });
  const server = serveChannel(pipe.readable, (line) => read(Buffer.from(line)), async (value) => { forwarded.push(value); });
  const writer = pipe.writable.getWriter();
  const bytes = Buffer.from(input);
  for (let i = 0; i < bytes.length; i += fragmentSize) await writer.write(bytes.subarray(i, i + fragmentSize));
  await writer.close(); await server;
  return { output: output as Record<string, any>[], forwarded };
}

test("MCP initialize and tools/list round-trip through an in-process pipe", async () => {
  const { output, forwarded } = await roundTrip([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "工具", method: "tools/list" },
  ].map((value) => JSON.stringify(value) + "\n").join(""));
  expect(output).toHaveLength(2);
  expect(output[0]?.result.capabilities).toEqual({ experimental: { "claude/channel": {} }, tools: {} });
  expect(output[0]?.result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(output[1]?.id).toBe("工具");
  expect(output[1]?.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["acknowledge", "reply"]);
  expect(forwarded).toEqual([{ type: "channel_initialize", protocolVersion: PROTOCOL_VERSION }, { type: "channel_ready" }]);
});

test("MCP rejects missing and untested protocol versions", async () => {
  const { output } = await roundTrip([{}, { protocolVersion: "2099-01-01" }].map((params, id) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params }) + "\n").join(""));
  expect(output.map((value) => value.error.code)).toEqual([-32602, -32602]);
});

test("MCP forwards valid tools and rejects malformed/unknown operations", async () => {
  const meta = { request_id: "r", revision: "1", delivery_id: "d", session_alias: "p0" };
  const calls = [
    { name: "acknowledge", arguments: meta },
    { name: "reply", arguments: { ...meta, status: "completed", text: "marker\n工具" } },
    { name: "delete", arguments: meta },
    { name: "reply", arguments: { ...meta, status: "unknown", text: "x" } },
    { name: "acknowledge", arguments: { ...meta, revision: "0" } },
    { name: "acknowledge", arguments: { ...meta, prompt: "no" } },
    { name: "reply", arguments: { ...meta, status: ["completed"], text: "x" } },
  ];
  const input = calls.map((params, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }) + "\n").join("");
  const { output, forwarded } = await roundTrip("{broken}\n" + input, 13);
  expect(forwarded).toEqual(calls.slice(0, 2).map((params) => ({ type: "tool_call", ...params })));
  expect(output[0]?.error.code).toBe(-32700);
  expect(output.slice(3).map((value) => value.error.code)).toEqual([-32602, -32602, -32602, -32602, -32602]);
});

test("tool forwarding failure returns MCP isError", async () => {
  const input = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "acknowledge", arguments: { request_id: "r", revision: "1", delivery_id: "d", session_alias: "p0" },
    } }) + "\n")); controller.close();
  } });
  let output = "";
  await serveChannel(input, (line) => { output += line; }, async () => { throw new Error("offline"); });
  expect(JSON.parse(output).result.isError).toBe(true);
});

for (const protocolVersion of ["2025-06-18", "2025-11-25"]) test(`MCP accepts and forwards observed client version ${protocolVersion}`, async () => {
  const { output, forwarded } = await roundTrip(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n");
  expect(output[0]?.result?.protocolVersion).toBe(protocolVersion);
  expect(forwarded).toEqual([{ type: "channel_initialize", protocolVersion }]);
});

test("probe artifact records the client protocolVersion from channel initialization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hotmic-protocol-"));
  const artifact = join(dir, "channel.jsonl");
  try {
    const protocolVersion = "2025-11-25";
    const input = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n").body!;
    await serveChannel(input, () => {}, async (event) => recordChannelEvent(artifact, event, 123));
    const rows = readFileSync(artifact, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toEqual([
      { at: 123, type: "socket", event: { type: "channel_initialize", protocolVersion } },
      { at: 123, type: "initialize", protocolVersion },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsupported client version is observable for diagnosis but still rejected", async () => {
  const protocolVersion = "2099-01-01";
  const { output, forwarded } = await roundTrip(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n");
  expect(output[0]?.error.code).toBe(-32602);
  expect(forwarded).toEqual([{ type: "channel_initialize", protocolVersion }]);
});
