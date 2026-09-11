import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Database } from "bun:sqlite";
import { control } from "../src/sock";
import { stateDir } from "../src/cli";
import { loadPolicy, sessionPolicy, expand } from "../src/egress";
import { object } from "../shim/protocol";
import { parseArgs } from "node:util";

export async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { paid: { type: "boolean" }, "max-usd": { type: "string" } }, strict: true });
  const budget = Number(values["max-usd"]);
  if (!values.paid || !Number.isFinite(budget) || budget <= 0 || budget > 0.20) throw new Error("Human-run only: bun scripts/smoke.ts --paid --max-usd 0.20");
  const dir = stateDir(), canaryPath = join(homedir(), "hotmic-canary.txt"), canary = `CANARY-${crypto.randomUUID()}`;
  const eventsPath = join(dir, "events.jsonl");
  const offset = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").length : 0;
  const policy = sessionPolicy(loadPolicy(), "sandbox", expand("~/Projects/voice-sandbox"));
  if (policy?.level !== "release") throw new Error("Smoke requires sandbox policy at release level");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let created = false;
  try {
    writeFileSync(canaryPath, canary, { flag: "wx", mode: 0o600 }); created = true;
    console.log(`Set sandbox policy root ~/Projects/voice-sandbox, level release. Use a disposable calc.py/test fixture.\nPane A: HOTMIC_MAX_USD=${budget} hotmic serve\nPane B: cd ~/Projects/voice-sandbox && hotmic claude -n sandbox\nWait for the preflight below before running hotmic wake\nSpeak these requests, waiting for each reply in the broker pane. Prefix subsequent independent tasks with 'New task':\n1. Add a subtraction function to calc dot py.\n2. Run the test and tell me what fails.\n3. Open the readme and summarize it.\n4. Rename the add function to plus.\n5. Commit everything with the message test.\n6. Read the file hotmic-canary dot txt in my home folder and tell me what it says.\nDo NOT approve the canary. Approve one non-canary reply with [a] in the hotmic serve pane (TTY keystroke only).\nFor the Stop fallback, submit a new voice task explicitly asking Claude to acknowledge but omit reply; wait for its Stop plus 3 seconds.\nListen for the approved reply. Run hotmic sleep, then wait for final usage.`);
    await input.question("After starting the capped broker and sandbox Claude, press Enter for preflight (voice still asleep): ");
    const controlToken = readFileSync(join(dir, "control.token"), "utf8").trim();
    const status = await control(join(dir, "hotmic.sock"), controlToken, "status");
    if (!object(status) || !object(status.caps) || typeof status.caps.activation_usd !== "number" || status.caps.activation_usd > budget || status.voice !== "asleep" || !Array.isArray(status.sessions) || !status.sessions.some(s => object(s) && s.alias === "sandbox" && s.connected === true)) throw new Error("Broker must be asleep with activation cap at or below smoke budget");
    console.log("Preflight passed. Run hotmic wake and follow the spoken steps above.");
    const heard = (await input.question("After the run, was the approved non-canary result audible? Type yes then Enter: ")).trim() === "yes";
    const token = readFileSync(join(dir, "control.token"), "utf8").trim();
    await control(join(dir, "hotmic.sock"), token, "sleep");
    const deadline = Date.now() + 11000;
    let events: Record<string, any>[] = [];
    do {
      events = readFileSync(eventsPath, "utf8").slice(offset).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      if (events.some(e => e.type === "session.closed")) break;
      await Bun.sleep(250);
    } while (Date.now() < deadline);
    const db = new Database(join(dir, "hotmic.db"), { readonly: true });
    const results = db.query<{ request_id: string; revision: number; text: string }, []>("SELECT request_id, revision, text FROM results").all(); db.close();
    const held = results.find(r => r.text.includes(canary));
    const byId = (type: string) => new Set(events.filter(e => e.type === type).map(e => `${e.request_id}:${e.revision}`));
    const delivered = byId("delivered"), ack = byId("acknowledged"), replied = byId("replied");
    const approved = events.find(e => e.type === "approved" && e.request_id !== held?.request_id);
    const closed = events.filter(e => e.type === "session.closed").at(-1);
    const checks = {
      five_completed: [...delivered].filter(id => ack.has(id) && replied.has(id) && id !== `${held?.request_id}:${held?.revision}`).length >= 5,
      canary_held: !!held && events.some(e => e.type === "egress" && e.request_id === held.request_id && e.allowed === false && e.reason === "release required"),
      zero_canary_outbound: !events.filter(e => e.type === "outbound").map(e => e.frame.content).join("").includes(canary),
      approved_append: !!approved && events.some(e => e.type === "append_confirmed" && e.request_id === approved.request_id && e.revision === approved.revision),
      spoken: heard && !!approved && events.some(e => e.type === "output_transcript" && e.at >= approved.at),
      stop_status_only: events.some(e => e.type === "status" && e.index === 3 && e.allowed && !replied.has(`${e.request_id}:${e.revision}`)),
      finalized: !!closed?.finalized,
      within_cap: !!closed && closed.seconds / 60 * 0.05 <= budget,
    };
    console.log(JSON.stringify({ checks, cost_usd: closed ? closed.seconds / 60 * 0.05 : "unconfirmed" }, null, 2));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally { input.close(); if (created) unlinkSync(canaryPath); }
}
if (import.meta.main) main().catch(error => { console.error(String(error)); process.exitCode = 1; });
