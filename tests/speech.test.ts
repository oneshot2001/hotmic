import { test, expect } from "bun:test";
import { SpeechQueue } from "../src/speech";
import { drain } from "./p2-helpers";
test("speech prioritizes questions and permissions, then results, then status in stable order", async () => {
  const q = new SpeechQueue(), out: string[] = [];
  const add = (kind: Parameters<SpeechQueue["enqueue"]>[0], alias: string) => q.enqueue(kind, alias, async () => { out.push(alias); });
  await Promise.all([add("status", "status"), add("result", "result"), add("question", "question"), add("permission", "permission")]);
  expect(out).toEqual(["question", "permission", "result", "status"]);
});
test("speech never interleaves payload chunks, even when a higher priority item arrives", async () => {
  const q = new SpeechQueue(), out: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const first = q.enqueue("result", "a", async () => { out.push("a1"); await gate; out.push("a2"); });
  await drain();
  const next = q.enqueue("question", "b", async () => { out.push("b1"); out.push("b2"); });
  await drain(); expect(out).toEqual(["a1"]);
  release(); await Promise.all([first, next]); expect(out).toEqual(["a1", "a2", "b1", "b2"]);
});
test("progress coalesces per alias for sixty seconds without suppressing other statuses", async () => {
  let now = 1000; const q = new SpeechQueue(() => now), out: string[] = [];
  const add = (alias: string, kind: "progress" | "status" = "progress") => q.enqueue(kind, alias, async () => { out.push(alias); });
  await Promise.all([add("a"), add("a"), add("b"), add("a", "status")]);
  now = 60999; await add("a"); expect(out).toEqual(["a", "b", "a"]);
  now = 61000; await add("a"); expect(out).toEqual(["a", "b", "a", "a"]);
});
test("failed speech item does not strand the next payload", async () => {
  const q = new SpeechQueue(), out: string[] = [];
  const failed = q.enqueue("result", "a", async () => { throw new Error("transport"); });
  const next = q.enqueue("result", "b", async () => { out.push("b"); });
  await expect(failed).rejects.toThrow("transport"); await next; expect(out).toEqual(["b"]);
});
