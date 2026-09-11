// Offline only: bun scripts/mutate.ts [case number ...]
// Mutate a disposable copy, never the working tree. No Claude, audio or paid smoke.
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
type Mutation = { name: string; file: string; replacements: [string, string][]; test: string; pattern?: string };
const cases: Mutation[] = [
  {"name": "registry token identity", "file": "src/registry.ts", "replacements": [["if (previous?.connected && previous.token_hash !== hash)", "if (false)"]], "test": "tests/registry.test.ts", "pattern": "rejects different"},
  {"name": "registry limit eight", "file": "src/registry.ts", "replacements": [["if (!previous && this.size >= 8)", "if (false)"]], "test": "tests/registry.test.ts", "pattern": "rejects different"},
  {"name": "registry immutable cwd/refs", "file": "src/registry.ts", "replacements": [["if (previous?.token_hash === hash && (previous.cwd !== cwd || previous.workspace_ref !== refs.workspace_ref || previous.surface_ref !== refs.surface_ref))", "if (false)"]], "test": "tests/registry.test.ts", "pattern": "rejects different"},
  {"name": "registry input validation", "file": "src/registry.ts", "replacements": [["if (!validAlias(alias) || !/^[a-f0-9]{64}$/.test(token) || !validRefs(refs))", "if (false)"]], "test": "tests/registry.test.ts", "pattern": "validates input"},
  {"name": "registry heartbeat six-second boundary", "file": "src/registry.ts", "replacements": [["now - row.last_heartbeat >= 6000", "now - row.last_heartbeat > 6000"]], "test": "tests/registry.test.ts", "pattern": "heartbeat expires"},
  {"name": "registry announce only on connected transition", "file": "src/registry.ts", "replacements": [["row.connected && now - row.last_heartbeat >= 6000 && this.disconnect(row.alias)", "now - row.last_heartbeat >= 6000"]], "test": "tests/registry.test.ts", "pattern": "heartbeat expires"},
  {"name": "registry heartbeat restores connected", "file": "src/registry.ts", "replacements": [["row.connected = true;", "row.connected = false;"]], "test": "tests/registry.test.ts", "pattern": "heartbeat expires"},
  {"name": "registry restart resets connection", "file": "src/registry.ts", "replacements": [["{ ...row, connected: false }", "{ ...row, connected: true }"]], "test": "tests/registry.test.ts", "pattern": "migration"},
  {"name": "registry migration idempotence", "file": "src/registry.ts", "replacements": [["if (!columns.has(name)) db.exec", "db.exec"]], "test": "tests/registry.test.ts", "pattern": "migration"},
  {"name": "shim heartbeat interval", "file": "shim/channel.ts", "replacements": [["JSON.stringify({ type: \"heartbeat\" }) + \"\\n\"), 2000)", "JSON.stringify({ type: \"heartbeat\" }) + \"\\n\"), 4000)"]], "test": "tests/registry.test.ts", "pattern": "shim sends"},
  {"name": "leading only", "file": "src/netcontrol.ts", "replacements": [["`^${tokens}(?=$|", "`${tokens}(?=$|"]], "test": "tests/netcontrol.test.ts"},
  {"name": "exact token boundary", "file": "src/netcontrol.ts", "replacements": [["if (!bareName && !separator.test(rest.trimStart()) && !/^\\s+/.test(rest)) return [];", ""], ["(?=$|[\\\\s,，:;…—–.!?])", ""]], "test": "tests/netcontrol.test.ts"},
  {"name": "verb or punctuation boundary", "file": "src/netcontrol.ts", "replacements": [["if (!bareName && !separator.test(rest.trimStart()) && !verbs.test(rest.trim())) return [];", ""]], "test": "tests/netcontrol.test.ts"},
  {"name": "strip leading alias", "file": "src/netcontrol.ts", "replacements": [["text: bareName ? \"\" : rest.replace(/^[\\s,，:;…—–.]+/, \"\").trim()", "text: input"]], "test": "tests/netcontrol.test.ts"},
  {"name": "explicit precedes pin", "file": "src/netcontrol.ts", "replacements": [["if (explicit) return", "if (explicit && !ctx.pinned) return"]], "test": "tests/netcontrol.test.ts"},
  {"name": "off explicit forbidden", "file": "src/netcontrol.ts", "replacements": [["explicit.row.level === \"off\"", "false"]], "test": "tests/netcontrol.test.ts"},
  {"name": "off pin forbidden", "file": "src/netcontrol.ts", "replacements": [["if (target.row.level === \"off\")", "if (false)"]], "test": "tests/netcontrol.test.ts"},
  {"name": "pin expires after five minutes", "file": "src/netcontrol.ts", "replacements": [["spokenAt - pin.lastRequestAt < 300000", "true"]], "test": "tests/netcontrol.test.ts"},
  {"name": "pin precedes focus", "file": "src/netcontrol.ts", "replacements": [["if (pin &&", "if (!ctx.focused && pin &&"]], "test": "tests/netcontrol.test.ts"},
  {"name": "pin policy still routable", "file": "src/netcontrol.ts", "replacements": [["s.alias === pin.alias && s.level !== \"off\"", "s.alias === pin.alias"]], "test": "tests/netcontrol.test.ts"},
  {"name": "focus unknown surface never inherits workspace", "file": "src/netcontrol.ts", "replacements": [["registry.filter(s => s.surface_ref === focused.surface_ref)", "registry.filter(s => s.surface_ref === focused.surface_ref || s.workspace_ref === focused.workspace_ref)"]], "test": "tests/netcontrol.test.ts"},
  {"name": "focus must be unique", "file": "src/netcontrol.ts", "replacements": [["matches.length === 1", "matches.length > 0"]], "test": "tests/netcontrol.test.ts"},
  {"name": "focus off excluded", "file": "src/netcontrol.ts", "replacements": [["(includeOff || matches[0]!.level !== \"off\")", "true"]], "test": "tests/netcontrol.test.ts"},
  {"name": "live list excludes unavailable", "file": "src/netcontrol.ts", "replacements": [["s.connected && s.level !== \"off\"", "true"]], "test": "tests/netcontrol.test.ts"},
  {"name": "ambiguous pronunciation collision", "file": "src/netcontrol.ts", "replacements": [["if (matches.some(m => m.length === best.length && m.row.alias !== best.row.alias)) return \"AMBIGUOUS\";", ""]], "test": "tests/netcontrol.test.ts"},
  {"name": "cmux uses caller fields at launch", "file": "src/cmux.ts", "replacements": [["value[focus ? \"focused\" : \"caller\"]", "value[\"focused\"]"]], "test": "tests/netcontrol.test.ts"},
  {"name": "cmux caller vars stripped for focus", "file": "src/cmux.ts", "replacements": [["!focus || !key.startsWith(\"CMUX_\")", "true"]], "test": "tests/netcontrol.test.ts"},
  {"name": "cmux invalid refs fail closed", "file": "src/cmux.ts", "replacements": [["validRefs(refs) ? refs : emptyRefs()", "refs"]], "test": "tests/netcontrol.test.ts"},
  {"name": "cmux browser never routes", "file": "src/cmux.ts", "replacements": [[" || (focus && fields.is_browser_surface === true)", ""]], "test": "tests/netcontrol.test.ts"},
  {"name": "capture focus at first fragment", "file": "src/broker.ts", "replacements": [["focused: captured.focused", "focused: this.focused"]], "test": "tests/p3-broker.test.ts"},
  {"name": "capture pin at first fragment", "file": "src/broker.ts", "replacements": [["pinned: captured.pinned", "pinned: this.pinned"]], "test": "tests/p3-broker.test.ts"},
  {"name": "clarification dispatch retained task", "file": "src/broker.ts", "replacements": [["intent: waiting.session_alias ? intent! : \"route\"", "intent: \"route\""]], "test": "tests/p3-broker.test.ts"},
  {"name": "that-one uses new focused pane", "file": "src/broker.ts", "replacements": [["pointing ? focusedAlias(registry, captured.focused) : null", "null"]], "test": "tests/p3-broker.test.ts"},
  {"name": "no disconnected dispatch, including correction", "file": "src/requests.ts", "replacements": [[" || !canDispatch(r.session_alias)", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "queued correction retains supersedes", "file": "src/requests.ts", "replacements": [["state.deliveries.find(v => v.request_id === r.id && v.revision === r.revision - 1)?.id", "undefined"]], "test": "tests/p3-broker.test.ts"},
  {"name": "delivery ownership cross-session", "file": "src/broker.ts", "replacements": [["r.session_alias !== alias || ", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "delivery capability ownership", "file": "src/broker.ts", "replacements": [[" || this.#owners.get(d.id) !== payloadHash(token)", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "old transport cannot heartbeat after replacement", "file": "src/sock.ts", "replacements": [[" || broker.sessions.get(alias)?.send !== send", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "stale disconnect cannot close replacement", "file": "src/broker.ts", "replacements": [["if (this.sessions.get(alias) !== s || s.send !== send) return;", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "speech priorities", "file": "src/speech.ts", "replacements": [["priority[a.kind] - priority[b.kind]", "0"]], "test": "tests/speech.test.ts"},
  {"name": "speech payload atomicity", "file": "src/speech.ts", "replacements": [["await item.run(); item.done();", "void item.run(); item.done();"]], "test": "tests/speech.test.ts"},
  {"name": "progress sixty-second coalescing", "file": "src/speech.ts", "replacements": [["< 60000", "< 0"]], "test": "tests/speech.test.ts"},
  {"name": "progress boundary at sixty seconds", "file": "src/speech.ts", "replacements": [["< 60000", "<= 60000"]], "test": "tests/speech.test.ts"},
  {"name": "egress fixed notice content", "file": "src/egress.ts", "replacements": [[" || text !== noticeText(n)", ""]], "test": "tests/p3-egress.test.ts"},
  {"name": "egress notice kind", "file": "src/egress.ts", "replacements": [["kind !== \"commentary\" || !n", "!n"]], "test": "tests/p3-egress.test.ts"},
  {"name": "egress notice alias list", "file": "src/egress.ts", "replacements": [["if (n.type === \"route\" && (!n.aliases.every(validAlias) || n.aliases.some(a => !Object.hasOwn(ctx.policy?.sessions ?? {}, a) || ctx.policy!.sessions[a]!.level === \"off\")))", "if (false)"]], "test": "tests/p3-egress.test.ts"},
  {"name": "egress notice alias identity", "file": "src/egress.ts", "replacements": [["n.alias !== sessionAlias || ", ""]], "test": "tests/p3-egress.test.ts"},
  {"name": "egress notice session policy", "file": "src/egress.ts", "replacements": [[" || !sessionPolicy(ctx.policy, n.alias, ctx.cwd) || sessionPolicy(ctx.policy, n.alias, ctx.cwd)!.level === \"off\"", ""]], "test": "tests/p3-egress.test.ts"},
  {"name": "queued result revision authorization", "file": "src/egress.ts", "replacements": [[" || !ctx.current", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "smoke exactly ten destinations", "file": "scripts/smoke-multi.ts", "replacements": [["deliveries.length === 10 && deliveries.every((d, i)", "deliveries.every((d, i)"]], "test": "tests/smoke-multi.test.ts"},
  {"name": "smoke destination match", "file": "scripts/smoke-multi.ts", "replacements": [["d.session_alias === multiSteps[i]!.alias", "true"]], "test": "tests/smoke-multi.test.ts"},
  {"name": "smoke require resolved ask", "file": "scripts/smoke-multi.ts", "replacements": [["order(e) > order(a) && order(e) < order(delivery)", "true"]], "test": "tests/smoke-multi.test.ts"},
  {"name": "smoke registered delivery only", "file": "scripts/smoke-multi.ts", "replacements": [["!!r && multiAliases.includes(r.session_alias)", "!!r"]], "test": "tests/smoke-multi.test.ts"},
  {"name": "smoke prefix correctness", "file": "scripts/smoke-multi.ts", "replacements": [[" && g.text.startsWith(`${r.session_alias}: `)", ""]], "test": "tests/smoke-multi.test.ts"},
  {"name": "smoke final usage required", "file": "scripts/smoke-multi.ts", "replacements": [["usage.every(u => u.finalized === 1)", "true"]], "test": "tests/smoke-multi.test.ts"},
  {"name": "smoke total cost cap", "file": "scripts/smoke-multi.ts", "replacements": [["usage.reduce((sum, u) => sum + u.usd, 0) <= budget", "true"]], "test": "tests/smoke-multi.test.ts"},
  {"name": "longest exact pronunciation wins", "file": "src/netcontrol.ts", "replacements": [["matches.sort((a, b) => b.length - a.length);", ""]], "test": "tests/netcontrol.test.ts"},
  {"name": "correction response grammar", "file": "src/netcontrol.ts", "replacements": [["return \"correction\";", "return null;"]], "test": "tests/netcontrol.test.ts"},
  {"name": "new-task response grammar", "file": "src/netcontrol.ts", "replacements": [["return \"new\";", "return null;"]], "test": "tests/netcontrol.test.ts"},
  {"name": "correction question exact wording", "file": "src/egress.ts", "replacements": [["Is that a correction or a new task for ${notice.alias}?", "Which session?"]], "test": "tests/p3-broker.test.ts"},
  {"name": "retained work not resent after reconnect", "file": "src/requests.ts", "replacements": [["if (r.state !== \"READY\" || deliveryFor(r) || !canDispatch(r.session_alias)) return;", "if (!canDispatch(r.session_alias)) return;"]], "test": "tests/requests.test.ts"},
  {"name": "destination clarification may ask a distinct intent question", "file": "src/requests.ts", "replacements": [["if (!r.session_alias && event.intent === \"route\") r.notices &= ~ASKED;", ""]], "test": "tests/p3-broker.test.ts"},
  {"name": "confirmed correction can supersede an exported result", "file": "src/requests.ts", "replacements": [["inFlight ?? (intent === \"correction\"", "inFlight ?? (false"]], "test": "tests/p3-broker.test.ts"},
  {"name": "confirmed correction retires exported epoch", "file": "src/broker.ts", "replacements": [["if ([\"RESULT_AVAILABLE\", \"SPOKEN\"].includes(old.state)) void this.live.close", "if (false) void this.live.close"]], "test": "tests/p3-broker.test.ts"},
  {"name": "disconnected alias accepts a new capability", "file": "src/registry.ts", "replacements": [["previous?.connected && previous.token_hash !== hash", "previous && previous.token_hash !== hash"]], "test": "tests/registry.test.ts", "pattern": "registry relaunch"},
  {"name": "rotation replaces stale token and transport", "file": "src/registry.ts", "replacements": [["previous?.token_hash === hash ? previous :", "previous ??"]], "test": "tests/registry.test.ts", "pattern": "registry relaunch"},
  {"name": "pending route accepts bare aliases only", "file": "src/broker.ts", "replacements": [[" && named.text === \"\"", ""]], "test": "tests/p3-broker.test.ts", "pattern": "pending route ask preserves"},
  {"name": "pending route re-asked after independent dispatch", "file": "src/broker.ts", "replacements": [["if (reminder) {", "if (false && reminder) {"]], "test": "tests/p3-broker.test.ts", "pattern": "pending route ask preserves"},
  {"name": "cancel consumes the pending route ask", "file": "src/broker.ts", "replacements": [["consume(); this.handle({ type: \"cancel\", request_id: waiting.id, revision: waiting.revision }); return true;", "consume(); return true;"]], "test": "tests/p3-broker.test.ts", "pattern": "bare focused-one and cancel"},
  {"name": "STT single period separator", "file": "src/netcontrol.ts", "replacements": [["const separator = /^[,，:;\\n\\r…—–.]|^\\.\\.\\./;", "const separator = /^[,，:;\\n\\r…—–]|^\\.\\.\\./;"]], "test": "tests/netcontrol.test.ts", "pattern": "STT periods"},
  {"name": "only still_working coalesces", "file": "src/broker.ts", "replacements": [["action.status === \"still_working\" ? \"progress\" : \"status\"", "\"progress\""]], "test": "tests/p3-broker.test.ts", "pattern": "waiting at two seconds"},
  {"name": "this-one stripped under pin", "file": "src/netcontrol.ts", "replacements": [["return { alias: pin.alias, text: task };", "return { alias: pin.alias, text };"]], "test": "tests/netcontrol.test.ts", "pattern": "this one is stripped"},
  {"name": "consumed fragment focus released", "file": "src/broker.ts", "replacements": [["for (const sequence of a.range.sequences) this.#fragmentFocus.delete(sequence);", ""]], "test": "tests/p3-broker.test.ts", "pattern": "consumed fragment focus"},
  {"name": "includeOff opt-in recognizes focused off session", "file": "src/netcontrol.ts", "replacements": [["includeOff || matches[0]!.level !== \"off\"", "matches[0]!.level !== \"off\""]], "test": "tests/netcontrol.test.ts", "pattern": "focusedAlias includes off"},
  {"name": "old registration cannot disconnect new identity", "file": "src/broker.ts", "replacements": [["this.sessions.get(alias) !== s || ", ""]], "test": "tests/p3-broker.test.ts", "pattern": "expired transport cannot disconnect"},
  {"name": "serve rejects minimum activation budget", "file": "src/cli.ts", "replacements": [["activationCap <= MIN_ACTIVATION_USD", "activationCap < MIN_ACTIVATION_USD"]], "test": "tests/cli.test.ts", "pattern": "serve rejects the minimum"},
  {"name": "smoke rejects minimum activation budget", "file": "scripts/smoke.ts", "replacements": [["budget <= MIN_ACTIVATION_USD", "budget < MIN_ACTIVATION_USD"]], "test": "tests/smoke-multi.test.ts", "pattern": "multi smoke rejects the minimum"}
];

export async function main(args = process.argv.slice(2)) {
  const selected = args.map(Number);
  if (selected.some(n => !Number.isInteger(n) || n < 1 || n > cases.length)) throw new Error("Expected mutation case numbers");
  const root = resolve(import.meta.dir, "..");
  const copy = mkdtempSync(join(tmpdir(), "hotmic-mutate-"));
  const log = join(root, "docs", selected.length ? "P3-MUTATIONS-selected.log" : "P3-MUTATIONS.log");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", ...args], {
      cwd: copy, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 60000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, output: stdout + stderr };
    } finally { clearTimeout(timer); }
  };
  try {
    for (const path of ["src", "shim", "scripts", "tests", "config", "prompts", "package.json", "tsconfig.json"])
      cpSync(join(root, path), join(copy, path), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");
    writeFileSync(log, `Bun ${Bun.version}; offline mutation run; ${new Date().toISOString()}\n`);
    const baseline = await run([]);
    appendFileSync(log, `\nBASELINE exit=${baseline.code}\n${baseline.output}`);
    if (baseline.code !== 0) throw new Error("Baseline failed; see mutation log");
    const results: string[] = [];
    for (const [index, mutation] of cases.entries()) {
      if (selected.length && !selected.includes(index + 1)) continue;
      const path = join(copy, mutation.file), original = readFileSync(path, "utf8");
      try {
        let changed = original;
        for (const [before, after] of mutation.replacements) {
          if (!changed.includes(before)) throw new Error(`Missing mutation target: ${mutation.name}`);
          changed = changed.replace(before, after);
        }
        writeFileSync(path, changed);
        const args = [mutation.test, ...(mutation.pattern ? ["-t", mutation.pattern] : [])];
        const { code, output } = await run(args);
        const assertion = /error: expect\(|error: Expected|AssertionError/.test(output);
        const result = code !== 0 && assertion ? "KILLED" : code !== 0 ? "ERROR" : "SURVIVED";
        results.push(result);
        const summary = `${index + 1}. ${mutation.name}: ${result}`;
        console.log(summary);
        appendFileSync(log, `\n${summary}\nFile: ${mutation.file}\nCommand: bun test ${args.join(" ")}\nExit: ${code}\n${output}`);
      } finally { writeFileSync(path, original); }
    }
    const summary = `${results.filter(r => r === "KILLED").length}/${results.length} KILLED`;
    appendFileSync(log, `\n${summary}\n`); console.log(summary);
    if (results.some(r => r !== "KILLED")) process.exitCode = 1;
  } finally { rmSync(copy, { recursive: true, force: true }); }
}
if (import.meta.main) await main();
