import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { hookEvents } from "../shim/hook";
import { loadPolicy, sessionPolicy, type Policy } from "./egress";
import { apiKey, credentials } from "./credentials";
import { openDB } from "./db";
import { Broker } from "./broker";
import { Live } from "./live";
import { control, listen } from "./sock";
import { execInteractive } from "./exec";
import { serveTerminal } from "./terminal";
export const TESTED_CLAUDE_VERSION = "2.1.269";
export const stateDir = () => process.env.HOTMIC_STATE ?? resolve(homedir(), ".local/state/hotmic");
export const childEnv = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !["OPENAI_API_KEY", "HOTMIC_CONTROL_TOKEN"].includes(key))) as Record<string, string>;
export function launchConfig(alias: string, cwd: string, token: string, run: string, socket: string, policy: Policy | null, extra: string[] = []) {
  if (!sessionPolicy(policy, alias, cwd)) throw new Error("Alias or working directory refused by policy");
  // These options would override the tested interactive channel configuration.
  if (extra.some(a => /^(?:-p|--print|--settings|--mcp-config|--strict-mcp-config|--dangerously-load-development-channels|--allowedTools|--tools)(?:=|$)/.test(a))) throw new Error("Conflicting Claude argument");
  const root = resolve(import.meta.dir, "..");
  // The two failure events remain parseable, but were not exercised by P0 on 2.1.269.
  const settings = { hooks: Object.fromEntries(hookEvents.filter(event => !["PostToolUseFailure", "StopFailure"].includes(event)).map(event => [event, [{ hooks: [{ type: "command", command: process.execPath,
    args: ["--no-env-file", join(root, "shim/hook.ts"), socket, alias, token], timeout: 5 }] }]])) };
  const mcp = { mcpServers: { hotmic: { command: process.execPath, args: ["--no-env-file", join(root, "shim/channel.ts")],
    env: { HOTMIC_SOCK: socket, HOTMIC_ALIAS: alias, HOTMIC_TOKEN: token } } } };
  const args = ["-n", alias, "--settings", join(run, "settings.json"), "--mcp-config", join(run, "mcp.json"),
    "--strict-mcp-config", "--dangerously-load-development-channels", "server:hotmic", "--allowedTools",
    "mcp__hotmic__acknowledge,mcp__hotmic__reply", ...extra];
  return { settings, mcp, args, env: childEnv(process.env) };
}
function localControl(command: string, args: Record<string, unknown> = {}) {
  const dir = stateDir();
  return control(join(dir, "hotmic.sock"), readFileSync(join(dir, "control.token"), "utf8").trim(), command, args);
}
async function installedClaudeVersion() {
  const executable = Bun.which("claude");
  if (!executable) return null;
  try {
    const child = Bun.spawn([executable, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const output = await new Response(child.stdout).text();
      return await child.exited === 0 ? output.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/)?.[1] ?? null : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}
export async function doctor() {
  const version = await installedClaudeVersion();
  let socket = false;
  try { await localControl("status"); socket = true; } catch { /* Report unreachable. */ }
  const checks = { bun: !!Bun.version, sox: !!Bun.which("sox") && !!Bun.which("play"),
    claude: version === TESTED_CLAUDE_VERSION, claude_version: version ?? "unverified (--version failed)",
    key_present: !!await apiKey(), policy_valid: !!loadPolicy(), socket_reachable: socket };
  console.log(JSON.stringify(checks, null, 2));
  return checks;
}
async function serve() {
  process.umask(0o077);
  const dir = stateDir(); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  // Exclusive lock: never unlink another broker's active socket or steal its database.
  const lock = join(dir, "broker.lock");
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  const activationCap = Number(process.env.HOTMIC_MAX_USD ?? "0.50");
  if (!Number.isFinite(activationCap) || activationCap <= 11 / 60 * 0.05 || activationCap > 0.50) { rmSync(lock); throw new Error("HOTMIC_MAX_USD must be greater than $0.00917 and at most $0.50"); }
  let broker: Broker | undefined, hub: Awaited<ReturnType<typeof listen>> | undefined;
  let db: ReturnType<typeof openDB> | undefined;
  let terminal: ReturnType<typeof serveTerminal> | undefined, render: ReturnType<typeof setInterval> | undefined;
  try {
    const secret = await credentials();
    const token = randomBytes(32).toString("hex");
    const log = (event: Record<string, unknown>) => appendFileSync(join(dir, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    db = openDB(join(dir, "hotmic.db")); chmodSync(join(dir, "hotmic.db"), 0o600);
    const live = new Live({ key: secret.key, event: event => broker!.event(event), audit: event => broker!.log(event) });
    broker = new Broker({ db, policy: loadPolicy, secrets: secret.values, secretsReady: secret.complete, live, log,
      caps: { activation_usd: activationCap, daily_usd: 3, idle_ms: 180000 } });
    hub = await listen(join(dir, "hotmic.sock"), broker, token);
    writeFileSync(join(dir, "control.token"), token, { mode: 0o600 });
    broker.start();
    terminal = serveTerminal(broker);
    render = setInterval(() => terminal!.render(), 250);
    console.log("hotmic serve ready; voice asleep.");
    await new Promise<void>(resolve => {
      const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
      process.on("SIGINT", done); process.on("SIGTERM", done);
    });
  } finally {
    clearInterval(render); terminal?.close();
    await broker?.stop(); await hub?.close(); db?.close(); rmSync(lock, { force: true });
  }
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === "doctor") { await doctor(); return; }
  if (command === "serve") { await serve(); return; }
  if (command === "claude") {
    if (args[1] !== "-n" || !args[2] || (args.length > 3 && args[3] !== "--")) throw new Error("Usage: hotmic claude -n <alias> [-- claude args]");
    const alias = args[2], cwd = process.cwd(), dir = stateDir(), token = randomBytes(32).toString("hex");
    if (!sessionPolicy(loadPolicy(), alias, cwd)) throw new Error("Session refused by policy");
    const run = mkdtempSync(join(dir, "run-")); chmodSync(run, 0o700);
    const config = launchConfig(alias, cwd, token, run, join(dir, "hotmic.sock"), loadPolicy(), args.slice(4));
    writeFileSync(join(run, "settings.json"), JSON.stringify(config.settings, null, 2), { mode: 0o600 });
    writeFileSync(join(run, "mcp.json"), JSON.stringify(config.mcp, null, 2), { mode: 0o600 });
    await localControl("register", { alias, cwd, capability: token });
    const executable = Bun.which("claude");
    if (!executable) throw new Error("Claude executable missing");
    await execInteractive(executable, config.args, config.env);
    return;
  }
  if (["wake", "sleep", "status", "usage"].includes(command ?? "")) { console.log(JSON.stringify(await localControl(command!), null, 2)); return; }
  throw new Error("Usage: hotmic serve | claude -n <alias> | wake | sleep | status | usage | doctor");
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "hotmic failed"); process.exitCode = 1; });
