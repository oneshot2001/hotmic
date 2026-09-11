import { homedir } from "node:os";
import { resolve } from "node:path";
const cred = resolve(homedir(), ".claude/bin/cred");
async function read(args: string[]) {
  try {
    const child = Bun.spawn([cred, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const output = await new Response(child.stdout).text();
      return await child.exited === 0 ? output.replace(/\r?\n$/, "") : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}
export async function apiKey() { return process.env.OPENAI_API_KEY || await read(["get", "OPENAI_API_KEY"]) || ""; }
export async function credentials() {
  const listing = await read(["list"]);
  const names = (listing ?? "").split("\n").filter(n => /^[A-Za-z0-9_-]+$/.test(n));
  const fetched = await Promise.all(names.map(n => read(["get", n])));
  const values = fetched.filter((value): value is string => typeof value === "string" && value.length > 0);
  const key = await apiKey();
  if (key) values.push(key);
  return { key, values, complete: listing !== null && fetched.every(v => v !== null) };
}
