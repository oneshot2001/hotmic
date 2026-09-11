import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CMUX_")));
const results = [];
for (const args of [["identify"], ["identify", "--no-caller"], ["workspace", "status"], ["list-windows"]]) {
  console.log(`$ cmux ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await run("cmux", args, { env: args.includes("--no-caller") ? env : process.env, timeout: 10_000 });
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    let fields: unknown = null;
    try { fields = JSON.parse(stdout); } catch { /* Preserve non-JSON output verbatim. */ }
    results.push({ command: ["cmux", ...args], stdout, stderr, fields, exitCode: 0 });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: unknown };
    console.error(failure.stderr || failure.message);
    results.push({ command: ["cmux", ...args], stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, exitCode: failure.code ?? 1 });
  }
}
const ok = results.every((result) => result.exitCode === 0);
function paths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}
const callerFields = paths(results[0]?.fields).filter((path) => /caller.*(workspace|surface)/i.test(path));
const focusedFields = paths(results[1]?.fields).filter((path) => !/caller/i.test(path) && /(workspace|surface)/i.test(path));
const summary = ok
  ? `Focus candidates in identify --no-caller: ${focusedFields.join(", ") || "UNRESOLVED"}; caller fields in identify: ${callerFields.join(", ") || "UNRESOLVED"}. Confirm across panes before routing.`
  : "Focused/caller fields UNCONFIRMED: one or more cmux commands failed; inspect the recorded errors and rerun with socket access.";
console.log(summary);
console.log("run this from three different cmux panes and once from a plain Terminal");
const dir = resolve(import.meta.dir, "../.runs/p0");
await mkdir(dir, { recursive: true, mode: 0o700 });
const path = `${dir}/cmux-${Date.now()}.json`;
await Bun.write(path, JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2) + "\n");
console.log(`Recorded: ${path}`);
process.exitCode = ok ? 0 : 1;
