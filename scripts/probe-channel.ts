import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { hookEvents, metadataKeys } from "../shim/hook";
import { jsonLines, object } from "../shim/protocol";

const root = resolve(import.meta.dir, "..");
const outputDir = resolve(root, ".runs/p0");
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
// Short path keeps the Unix socket below macOS's path-length limit.
const runDir = mkdtempSync("/private/tmp/hotmic-p0-");
chmodSync(runDir, 0o700);
const sockPath = `${runDir}/hotmic.sock`;
const artifact = `${outputDir}/channel-${Date.now()}.jsonl`;
const record = (value: unknown) => appendFileSync(artifact, JSON.stringify({ at: Date.now(), ...object(value) ? value : { value } }) + "\n", { mode: 0o600 });
const marker = `HOTMIC_P0_${crypto.randomUUID()}`;
const meta = { request_id: crypto.randomUUID(), revision: "1", delivery_id: crypto.randomUUID(), session_alias: "p0" };
const events: Record<string, unknown>[] = [];
const sockets = new Set<Socket>();
let sent = false;
let malformed = false;
let replied = false;
let nudged = false;
let channelSocket: Socket | null = null;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => { malformed = true; });
  let pending = Buffer.alloc(0);
  let mode: "http" | "lines" | undefined;
  const lines = jsonLines((value) => {
    if (!object(value)) { malformed = true; return; }
    events.push(value); record({ type: "socket", event: value });
    if (value.type === "channel_ready") channelSocket = socket;
    if (value.type === "tool_call" && value.name === "reply") replied = true;
  }, () => { malformed = true; });
  socket.on("data", (data) => {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (mode === "lines") { lines(bytes); return; }
    pending = Buffer.concat([pending, bytes]);
    if (!mode && pending.length >= 5) mode = pending.subarray(0, 5).toString() === "POST " ? "http" : "lines";
    if (mode === "lines") { lines(pending); pending = Buffer.alloc(0); return; }
    if (pending.length > 1_048_576) { malformed = true; socket.destroy(); return; }
    const split = pending.indexOf("\r\n\r\n");
    if (split < 0) return;
    const headers = pending.subarray(0, split).toString();
    const size = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
    if (!Number.isSafeInteger(size) || size < 0 || !headers.startsWith("POST /hook HTTP/1.1")) { malformed = true; socket.destroy(); return; }
    if (pending.length < split + 4 + size) return;
    try {
      const metadata: unknown = JSON.parse(pending.subarray(split + 4, split + 4 + size).toString());
      if (!object(metadata)) throw new Error("Invalid metadata");
      events.push({ type: "hook", metadata }); record({ type: "hook", metadata });
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    } catch { malformed = true; socket.destroy(); }
  });
});

let userSessionStartCount: number | null = null;
try {
  const settings = JSON.parse(readFileSync(resolve(homedir(), ".claude/settings.json"), "utf8"));
  userSessionStartCount = settings.hooks?.SessionStart?.flatMap((entry: { hooks?: unknown[] }) => entry.hooks ?? []).length ?? 0;
} catch { /* Never print the user's settings contents. */ }
const userHooks = { status: "UNVERIFIED", configuredSessionStartHooks: userSessionStartCount,
  reason: "CLI exposes no effective-settings dump. User settings are left enabled and untouched; receipt of our SessionStart does not prove the user's hook ran." };

const serve = process.argv.includes("--serve");
let exitCode: number | null = null;
let result: unknown = null;
try {
  const { stdout } = await promisify(execFile)("claude", ["--version"], { timeout: 10_000 });
  console.log(stdout.trim()); record({ type: "version", version: stdout.trim(), runDir });
  await Bun.write(`${runDir}/mcp.json`, JSON.stringify({ mcpServers: { hotmic: {
    command: process.execPath, args: ["--no-env-file", resolve(root, "shim/channel.ts")], env: { HOTMIC_SOCK: sockPath },
  } } }, null, 2));
  await Bun.write(`${runDir}/settings.json`, JSON.stringify({ hooks: Object.fromEntries(hookEvents.map((event) => [event, [{
    hooks: [{ type: "command", command: process.execPath, args: ["--no-env-file", resolve(root, "shim/hook.ts"), sockPath], timeout: 5 }],
  }]])) }, null, 2));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(sockPath, resolve); });
  chmodSync(sockPath, 0o600);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--settings", `${runDir}/settings.json`, "--mcp-config", `${runDir}/mcp.json`,
    "--strict-mcp-config", "--dangerously-load-development-channels", "server:hotmic",
    "--allowedTools", "mcp__hotmic__acknowledge,mcp__hotmic__reply", "--tools", "", "--no-session-persistence"];
  const prompt = "A hotmic channel message will arrive after this turn. When it does, call acknowledge and reply with its text verbatim and status completed, copying its metadata to both calls, then repeat that text in your final answer. For now, answer only: ready.";
  record({ type: "launch", command: ["claude", ...args], serve });
  if (serve) {
    const interactive = ["claude", "-n", "hotmic-p0", ...args.filter((a) => a !== "-p" && a !== "--verbose" && !a.includes("stream-json") && a !== "--input-format" && a !== "--output-format" && a !== "--no-session-persistence")];
    console.log(`\nRun this in a cmux pane (then, in Claude, type: ${prompt})\n\n  cd ${runDir} && ${interactive.map((a) => (a.includes(" ") || a === "" ? JSON.stringify(a) : a)).join(" ")}\n\nWaiting up to 10 min for the reply tool call...`);
    await new Promise<void>((done) => {
      const poll = setInterval(() => { if (channelSocket && !sent) { sent = true; channelSocket.write(JSON.stringify({ content: marker, meta }) + "\n"); record({ type: "notification_sent", content: marker, meta }); console.log("notification sent; Claude should now call acknowledge + reply"); } if (replied) { clearInterval(poll); done(); } }, 500);
      setTimeout(() => { clearInterval(poll); done(); }, 600_000);
    });
    exitCode = 0; result = { results: [replied ? marker : ""], is_error: false, result: replied ? marker : "" };
    throw new Error("__serve_done__");
  }
  const child = Bun.spawn(["claude", ...args], { cwd: runDir, env: { ...process.env, HOTMIC_SOCK: sockPath }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => { record({ type: "timeout", seconds: 120 }); child.kill("SIGTERM"); }, 120_000);
  const hardTimeout = setTimeout(() => child.kill("SIGKILL"), 125_000);
  const results: string[] = [];
  let turns = 0;
  const notify = () => {
    if (sent || !channelSocket) return;
    sent = true;
    channelSocket.write(JSON.stringify({ content: marker, meta }) + "\n");
    record({ type: "notification_sent", content: marker, meta });
    // Idle delivery: does the channel event start a turn by itself? Wait 15 s. If not,
    // send a nudge turn (doc: queued events are delivered on the next turn) and record which path worked.
    const nudge = setTimeout(() => {
      if (replied || turns >= 2) return;
      nudged = true; record({ type: "nudge_sent" });
      child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Check for the hotmic channel message now and handle it as instructed." } }) + "\n");
    }, 15_000);
    const poll = setInterval(() => { if (replied || turns >= 3) { clearInterval(poll); clearTimeout(nudge); setTimeout(() => child.stdin.end(), 3_000); } }, 500);
    setTimeout(() => { clearInterval(poll); clearTimeout(nudge); child.stdin.end(); }, 75_000);
  };
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  const stdoutLines = jsonLines((value) => {
    if (!object(value)) return;
    record({ type: "claude_stream", event: value });
    if (value.type === "result") {
      turns += 1;
      if (typeof value.result === "string") results.push(value.result);
      if (turns === 1) setTimeout(notify, 500);
    }
  }, () => {});
  try {
    const reader = child.stdout.getReader();
    const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; stdoutLines(Buffer.from(value)); } })();
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    await pump;
    exitCode = code;
    result = { results, is_error: false, result: results.join("\n") };
    record({ type: "claude_result", exitCode, results, stderr });
    if (stderr) console.error(stderr);
  } finally { clearTimeout(timeout); clearTimeout(hardTimeout); }
} catch (error) {
  if (!(error instanceof Error && error.message === "__serve_done__")) {
  const code = object(error) ? error.code : undefined;
  record({ type: "probe_error", error: String(error), code }); console.error(String(error), code ?? "");
  }
}
finally {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!serve && !process.argv.includes("--keep")) { try { rmSync(runDir, { recursive: true, force: true }); } catch {} }
}

const matches = (event: Record<string, unknown>, name: string) => event.type === "tool_call" && event.name === name && object(event.arguments)
  && Object.entries(meta).every(([key, value]) => (event.arguments as Record<string, unknown>)[key] === value);
const hooks = events.filter((event) => event.type === "hook");
const checks = {
  "one notification sent": sent,
  "acknowledge received": events.some((event) => matches(event, "acknowledge")),
  "reply contains exact marker": events.some((event) => matches(event, "reply") && object(event.arguments) && event.arguments.text === marker && event.arguments.status === "completed"),
  "hooks received with metadata only": !malformed && hooks.length > 0 && hooks.every((event) => object(event.metadata)
    && typeof event.metadata.session_id === "string" && hookEvents.includes(String(event.metadata.hook_event_name))
    && Object.entries(event.metadata).every(([key, value]) => metadataKeys.includes(key) && typeof value === "string"))
    && hooks.some((event) => object(event.metadata) && event.metadata.hook_event_name === "SessionStart"),
  "delivered without a nudge turn (idle delivery)": sent && !nudged,
  "Claude JSON result mentions marker": exitCode === 0 && object(result) && result.is_error !== true && typeof result.result === "string" && result.result.includes(marker),
};
for (const [name, pass] of Object.entries(checks)) console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
console.log(`UNVERIFIED: existing user SessionStart hooks (${userHooks.reason})`);
record({ type: "assertions", checks, userHooks });
console.log(`Recorded: ${artifact}\nConfigs: ${runDir}`);
process.exitCode = Object.entries(checks).every(([name, pass]) => pass || name.startsWith("delivered without")) ? 0 : 1;
