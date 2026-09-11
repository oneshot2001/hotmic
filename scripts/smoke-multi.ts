import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Database } from "bun:sqlite";
import { control } from "../src/sock";
import { stateDir } from "../src/cli";
import { object } from "../shim/protocol";
import type { RequestStore } from "../src/requests";
import type { Usage } from "../src/ledger";
export const multiAliases = ["alpha", "bravo", "charlie", "delta", "echo"];
export const multiSteps = [
  { alias: "alpha", say: "alpha, New task: read fixture.txt and report P3 step one.", action: "Leading alias." },
  { alias: "charlie", say: "charlie, New task: read fixture.txt and report P3 step two.", action: "Leading alias." },
  { alias: "bravo", say: "New task: read fixture.txt and report P3 step three.", action: 'First say "talk to bravo"; wait for "Talking to bravo."' },
  { alias: "bravo", say: "New task: read fixture.txt and report P3 step four.", action: "Keep the pin." },
  { alias: "delta", say: "this one, New task: read fixture.txt and report P3 step five.", action: "After step 4, hotmic sleep; wait at least FIVE MINUTES with no requests (unpaid, voice asleep). Verify status pinned:null. Focus delta, then explicitly wake again." },
  { alias: "echo", say: "New task: read fixture.txt and report P3 step six.", action: "Focus echo before speaking." },
  { alias: "alpha", say: "New task: read fixture.txt and report P3 step seven.", action: 'Focus the unregistered serve pane. Expect Which session? and NO delivery; answer "alpha".' },
  { alias: "charlie", say: "charlie, New task: read fixture.txt and report P3 step eight. Include the words ask bravo to review in the reply.", action: "Interior bravo must not change destination." },
  { alias: "charlie", say: "charlie, read fixture.txt and report P3 step eight. Include the words ask bravo to review in the reply.", action: 'Repeat step 8 without New task. Expect correction/new-task question and NO delivery; answer "new task".' },
  { alias: "echo", say: "echo, New task: read fixture.txt [pause two seconds] and report P3 step ten.", action: "Keep the pause inside one request." },
];
type Event = Record<string, any>;
export function gradeMulti(events: Event[], store: RequestStore, usage: Pick<Usage, "usd" | "finalized">[], budget: number, heard: boolean) {
  const deliveries = events.filter(e => e.type === "delivered");
  const results = events.filter(e => e.type === "outbound" && e.source === "reply");
  const groups = new Map<string, { alias: string; text: string }>();
  let last = "", interleaved = false;
  for (const e of results) {
    const key = `${e.request_id}:${e.revision}`;
    if (groups.has(key) && key !== last) interleaved = true;
    const group = groups.get(key) ?? { alias: e.session_alias, text: "" };
    group.text += e.frame?.content ?? ""; groups.set(key, group); last = key;
  }
  const asked = events.filter(e => e.type === "ask");
  const order = (e: Event) => events.indexOf(e);
  const checks = {
    ten_correct_destinations: deliveries.length === 10 && deliveries.every((d, i) => d.session_alias === multiSteps[i]!.alias),
    ten_acknowledged_replied: deliveries.length === 10 && deliveries.every(d => ["acknowledged", "replied"].every(type => events.some(e => e.type === type && e.request_id === d.request_id && e.revision === d.revision))),
    ambiguous_never_dispatched: asked.length >= 2 && asked.every(a => {
      const delivery = deliveries.find(d => d.request_id === a.request_id);
      return !delivery || events.some(e => e.type === "net control" && e.operation === "resolve" && e.request_id === a.request_id && order(e) > order(a) && order(e) < order(delivery));
    }),
    off_unregistered_never_delivered: store.deliveries.every(d => {
      const r = store.requests.find(r => r.id === d.request_id && r.revision === d.revision);
      return !!r && multiAliases.includes(r.session_alias);
    }) && deliveries.every(d => multiAliases.includes(d.session_alias)),
    every_result_prefixed: groups.size === 10 && !interleaved && [...groups.entries()].every(([key, g]) => {
      const r = store.requests.find(r => `${r.id}:${r.revision}` === key);
      return !!r && r.session_alias === g.alias && g.text.startsWith(`${r.session_alias}: `);
    }),
    audible_prefixes_confirmed: heard && events.some(e => e.type === "output_transcript"),
    finalized: usage.length > 0 && usage.every(u => u.finalized === 1),
    within_cap: usage.length > 0 && usage.reduce((sum, u) => sum + u.usd, 0) <= budget,
  };
  return { checks, cost_usd: usage.reduce((sum, u) => sum + u.usd, 0), destinations: deliveries.map((d, i) => ({ step: i + 1, expected: multiSteps[i]?.alias, observed: d.session_alias })) };
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
export async function smokeMulti(grade: boolean, budget: number) {
  let dir = stateDir();
  if (!grade) {
    const run = mkdtempSync(join(tmpdir(), "hotmic-multi-"));
    dir = join(run, "state"); mkdirSync(dir, { mode: 0o700 });
    const root = join(homedir(), "Projects/hotmic-smoke"); mkdirSync(root, { recursive: true });
    for (const alias of multiAliases) {
      const repo = join(root, alias);
      mkdirSync(repo); // Refuse existing repositories; never overwrite the operator's work.
      writeFileSync(join(repo, "fixture.txt"), `Disposable hotmic smoke fixture for ${alias}.\n`, { flag: "wx" });
      const init = Bun.spawnSync(["git", "init", "--quiet", repo], { stdout: "ignore", stderr: "ignore" });
      if (init.exitCode !== 0) throw new Error("Could not initialize disposable smoke repo");
    }
    const policyPath = join(run, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ default: "off", denyRoots: [], sessions: Object.fromEntries(multiAliases.map(alias => [alias, { root: join(root, alias), level: "release", aliases: [alias] }])) }, null, 2), { mode: 0o600, flag: "wx" });
    writeFileSync(join(dir, "multi-smoke.json"), JSON.stringify({ root, policyPath, budget }), { mode: 0o600 });
    const hotmic = quote(resolve(import.meta.dir, "../bin/hotmic"));
    const env = `export HOTMIC_STATE=${quote(dir)} HOTMIC_POLICY=${quote(policyPath)}`;
    console.log(`Temporary HOTMIC_POLICY: ${policyPath}\n${readFileSync(policyPath, "utf8")}\nIn EVERY pane first run:\n${env}\nServe pane:\nHOTMIC_MAX_USD=${budget / 2} ${hotmic} serve\nOpen FIVE cmux panes and run one command per pane:`);
    for (const alias of multiAliases) console.log(`cd ${quote(join(root, alias))} && ${hotmic} claude -n ${alias}`);
    console.log("No process has been launched by this script. Wait for preflight before wake. Approve each of the ten result payloads with [a] in the serve TTY; hear the alias prefix, then continue. Every result must be short. Both voice activations combined must remain under the cap.");
    console.table(multiSteps.map((s, i) => ({ step: i + 1, expected: s.alias, observed: "________", action: s.action, speak: s.say })));
    console.log(`Afterward grade again with:\n${env}\nbun scripts/smoke.ts --scenario multi --grade --max-usd ${budget}\nRepos and private run artifacts are retained for inspection. Remove only these disposable paths after grading: ${root}/{alpha,bravo,charlie,delta,echo} and ${run}`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "multi-smoke.json"), "utf8"));
  if (manifest.budget !== budget) throw new Error("Budget must match the recorded smoke run");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!grade) {
      await input.question("After serve and all five shims are ready (voice still asleep), press Enter for preflight: ");
      const token = readFileSync(join(dir, "control.token"), "utf8").trim();
      const status = await control(join(dir, "hotmic.sock"), token, "status");
      if (!object(status) || status.voice !== "asleep" || !object(status.caps) || Number(status.caps.activation_usd) > budget / 2 || !Array.isArray(status.sessions) ||
        !multiAliases.every(alias => (status.sessions as unknown[]).some((s: unknown) => object(s) && s.alias === alias && s.connected === true))) throw new Error("Preflight failed: need five connected sessions, asleep voice, and capped broker");
      console.log("Preflight passed. Run hotmic wake. Speak the ten steps in order; at step 5 sleep for pin expiry before explicitly waking. Finally run hotmic sleep and wait 11 seconds for finalized usage.");
    }
    const heard = (await input.question("After FINISHING and sleeping voice, did you hear all ten results with their correct alias prefixes? Type yes: ")).trim() === "yes";
    const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const db = new Database(join(dir, "hotmic.db"), { readonly: true });
    try {
      const store = Object.fromEntries(["requests", "deliveries", "results", "delegations"].map(table => [table, db.query(`SELECT * FROM ${table}`).all()])) as RequestStore;
      const result = gradeMulti(events, store, db.query<Usage, []>("SELECT * FROM usage").all(), budget, heard);
      console.log(JSON.stringify(result, null, 2));
      if (!Object.values(result.checks).every(Boolean)) process.exitCode = 1;
    } finally { db.close(); }
  } finally { input.close(); }
}
