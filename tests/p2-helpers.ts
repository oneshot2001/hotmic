import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { openDB } from "../src/db";
import { Broker } from "../src/broker";
import { Egress, type Append, type Level, type Policy } from "../src/egress";
import type { LivePort } from "../src/live";
export function sandbox(level: Level = "release") {
  const dir = mkdtempSync(join(tmpdir(), "hm-")), root = join(dir, "aar"), denied = join(dir, "denied");
  mkdirSync(root); mkdirSync(denied); mkdirSync(join(dir, "aar2"));
  const path = join(dir, "policy.json");
  const policy: Policy = { default: "off", denyRoots: [denied], sessions: { sandbox: { root, level }, other: { root, level } } };
  writeFileSync(path, JSON.stringify(policy));
  return { dir, root, denied, path, policy, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export class FakeLive implements LivePort {
  awake = false;
  frames: Append[] = [];
  closes: string[] = [];
  egress = new Egress(async append => { this.frames.push(append); });
  wake() { this.awake = true; }
  async close(reason: string) { this.closes.push(reason); this.awake = false; }
}
export function harness(level: Level = "release") {
  const files = sandbox(level), db = openDB(), live = new FakeLive();
  let now = 10000;
  const events: Record<string, unknown>[] = [], deliveries: any[] = [];
  const options = { db, live, policy: () => files.policy, secrets: [], now: () => now, log: (e: Record<string, unknown>) => events.push(e) };
  const broker = new Broker(options);
  const token = "a".repeat(64);
  broker.register("sandbox", files.root, token, { workspace_ref: "workspace:test", surface_ref: "surface:test" });
  broker.connect("sandbox", token, value => deliveries.push(value));
  broker.ready("sandbox");
  broker.focused = { workspace_ref: "workspace:test", surface_ref: "surface:test" };
  broker.wake();
  function request(id = "d1", text = "New task: test") {
    broker.handle({ type: "delegation", id, voice_epoch: "test", offset_ms: 1 });
    broker.handle({ type: "transcript", delegation_id: id, text });
    broker.ready("sandbox");
    return deliveries.at(-1).meta;
  }
  return { ...files, db, live, broker, options, token, events, deliveries, request,
    advance: (ms: number) => { now += ms; broker.tick(); },
    cleanup: () => { db.close(); files.cleanup(); } };
}
export const drain = () => new Promise<void>(resolve => setImmediate(resolve));
export class FakeTTY extends EventEmitter {
  isTTY = true;
  isRaw = false;
  resumed = false;
  setRawMode(raw: boolean) { this.isRaw = raw; return this; }
  resume() { this.resumed = true; return this; }
  pause() { this.resumed = false; return this; }
  key(text: string) { this.emit("data", Buffer.from(text)); }
}
