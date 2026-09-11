import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { childEnv, launchConfig, main } from "../src/cli";
import { hookEvents, hookMetadata } from "../shim/hook";
import { sandbox } from "./p2-helpers";
test("launcher generates interactive P0 flags, accepted exec hooks and authenticated MCP", () => {
  const f = sandbox();
  try {
    const c = launchConfig("sandbox", f.root, "token", f.dir, "/tmp/socket", f.policy, ["--model", "test"]);
    expect(c.args).toContain("--strict-mcp-config"); expect(c.args).toContain("server:hotmic");
    expect(c.args).not.toContain("-p"); expect(c.args).not.toContain("--tools");
    expect(c.args.slice(0, 2)).toEqual(["-n", "sandbox"]);
    expect(Object.keys(c.settings.hooks).sort()).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"].sort());
    expect(hookEvents).toContain("PostToolUseFailure"); expect(hookEvents).toContain("StopFailure");
    for (const event of ["PostToolUseFailure", "StopFailure"]) {
      expect(hookMetadata({ hook_event_name: event, session_id: "s", tool_response: "PRIVATE" })).toEqual({ session_id: "s", hook_event_name: event });
    }
    for (const hooks of Object.values(c.settings.hooks)) {
      expect(hooks[0]!.hooks[0]!.args.slice(-3)).toEqual(["/tmp/socket", "sandbox", "token"]);
      expect(hooks[0]!.hooks[0]!.type).toBe("command");
    }
    expect(c.mcp.mcpServers.hotmic.env.HOTMIC_TOKEN).toBe("token");
    expect(JSON.stringify(c.settings)).not.toContain("MessageDisplay");
  } finally { f.cleanup(); }
});
test("CLI has no approve or reject command even with well-formed arguments", async () => {
  const f = sandbox(), previous = process.env.HOTMIC_STATE;
  process.env.HOTMIC_STATE = f.dir;
  try {
    for (const command of ["approve", "reject"]) {
      await expect(main([command, "r1", "1", "a".repeat(64)])).rejects.toThrow("Usage: hotmic serve | claude -n <alias> | wake | sleep | status | usage | doctor");
    }
  } finally {
    if (previous === undefined) delete process.env.HOTMIC_STATE; else process.env.HOTMIC_STATE = previous;
    f.cleanup();
  }
});
test("doctor invokes only --version and checks the exact Claude pin, failing closed on bad output or exit", async () => {
  const f = sandbox();
  try {
    for (const [version, code, expected] of [["2.1.269 (Claude Code)", 0, true], ["2.1.270 (Claude Code)", 0, false],
      ["not a version", 0, false], ["2.1.269 (Claude Code)", 1, false]] as const) {
      writeFileSync(join(f.dir, "claude"), '#!/bin/sh\n[ "$#" -eq 1 ] && [ "$1" = "--version" ] || exit 99\nprintf "%s\\n" "' + version + '"\nexit ' + code + '\n', { mode: 0o700 });
      const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/cli.ts"), "doctor"], {
        env: { PATH: f.dir, HOME: f.dir, OPENAI_API_KEY: "test-only", HOTMIC_STATE: f.dir, HOTMIC_POLICY: f.path },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      const checks = JSON.parse(output);
      expect(checks.claude).toBe(expected);
      expect(checks.claude_version).toBe(code === 0 && version !== "not a version" ? version.split(" ")[0] : "unverified (--version failed)");
    }
  } finally { f.cleanup(); }
});
test("launcher denies unknown, denied and sibling roots plus print/config overrides", () => {
  const f = sandbox();
  try {
    for (const root of [f.denied, join(f.dir, "aar2")]) expect(() => launchConfig("sandbox", root, "t", f.dir, "s", f.policy)).toThrow();
    expect(() => launchConfig("unknown", f.root, "t", f.dir, "s", f.policy)).toThrow();
    for (const arg of ["-p", "--print=true", "--tools", "--mcp-config"]) expect(() => launchConfig("sandbox", f.root, "t", f.dir, "s", f.policy, [arg])).toThrow();
  } finally { f.cleanup(); }
});
test("OpenAI key never appears in Claude child env", () => {
  const env = childEnv({ OPENAI_API_KEY: "secret", HOTMIC_CONTROL_TOKEN: "owner", PATH: "/bin", KEEP: "yes" });
  expect(env).toEqual({ PATH: "/bin", KEEP: "yes" });
});
test("runtime supports process replacement without starting Claude", async () => {
  const target = 'process.stdout.write("replaced"); process.exit(7)';
  const script = `import { execInteractive } from ${JSON.stringify(join(import.meta.dir, "../src/exec.ts"))}; await execInteractive(process.execPath, ["--no-env-file", "-e", ${JSON.stringify(target)}], { PATH: process.env.PATH });`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text();
  expect({ code: await child.exited, output, error }).toEqual({ code: 7, output: "replaced", error: "" });
});
