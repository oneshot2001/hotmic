import { expect, test } from "bun:test";
import { assembled, emptyTranscripts, transcriptStep, type TranscriptEvent } from "../src/transcripts";
import { replay } from "../scripts/replay";

function assembler() {
  let state = emptyTranscripts();
  const diagnostics: unknown[] = [];
  return {
    send(event: TranscriptEvent, now: number) { const next = transcriptStep(state, event, now); state = next.state; diagnostics.push(...next.diagnostics); return next.ready; },
    diagnostics: () => diagnostics,
    get: (id: string) => assembled(state, id), snapshot: () => state,
  };
}

test("boundary requires 650ms silence then 250ms fragment quiet; about stays whole", () => {
  const a = assembler();
  a.send({ type: "delegation", id: "about", offset_ms: 31600 }, 0);
  a.send({ type: "fragment", fragment: { start_ms: 31000, end_ms: 31200, delta: "Tell me " } }, 10);
  a.send({ type: "fragment", fragment: { start_ms: 31600, end_ms: 31800, delta: "about" } }, 100);
  a.send({ type: "silence", at_ms: 100, silent: true }, 100);
  expect(a.send({ type: "tick" }, 999)).toEqual([]);
  expect(a.get("about")).toBe("NOT_READY");
  expect(a.send({ type: "tick" }, 1000)[0]).toEqual({ id: "about", text: "Tell me about", range: { start_ms: 31000, end_ms: 31800, sequences: [0, 1] } });
  expect(a.send({ type: "delegation", id: "about", offset_ms: 31600 }, 1001)).toEqual([]);
  expect(a.snapshot().delegations).toHaveLength(1);
});

for (const delay of [0, 250, 650, 2000, 10000]) test(`empty delegation survives ${delay}ms delayed fragments`, () => {
  const a = assembler();
  a.send({ type: "silence", at_ms: 0, silent: true }, 0);
  a.send({ type: "delegation", id: "d", offset_ms: 100 }, 900);
  expect(a.send({ type: "tick" }, 900 + delay)).toEqual([]);
  expect(a.get("d")).toBe("NOT_READY");
  a.send({ type: "fragment", fragment: { start_ms: 100, end_ms: 300, delta: " late text" } }, 900 + delay);
  expect(a.send({ type: "tick" }, 1149 + delay)).toEqual([]);
  expect(a.send({ type: "tick" }, 1150 + delay)[0]?.text).toBe("late text");
});

test("silence during a four-second pause never splits a request without delegation", () => {
  const a = assembler();
  a.send({ type: "fragment", fragment: { start_ms: 0, end_ms: 200, delta: "Open." } }, 0);
  a.send({ type: "silence", at_ms: 0, silent: true }, 0);
  expect(a.send({ type: "tick" }, 4000)).toEqual([]);
  a.send({ type: "silence", at_ms: 4000, silent: false }, 4000);
  a.send({ type: "fragment", fragment: { start_ms: 4000, end_ms: 4200, delta: " Open the readme" } }, 4100);
  a.send({ type: "silence", at_ms: 4200, silent: true }, 4200);
  a.send({ type: "delegation", id: "d", offset_ms: 4500 }, 4300);
  expect(a.send({ type: "tick" }, 5100)[0]?.text).toBe("Open. Open the readme");
});

test("late fragments after a consumed boundary belong to the next delegation; no reuse", () => {
  const a = assembler();
  a.send({ type: "silence", at_ms: 0, silent: true }, 0);
  a.send({ type: "fragment", fragment: { start_ms: 0, end_ms: 200, delta: "first" } }, 0);
  a.send({ type: "delegation", id: "d1", offset_ms: 200 }, 900);
  a.send({ type: "tick" }, 1150);
  a.send({ type: "fragment", fragment: { start_ms: 100, end_ms: 200, delta: "late " } }, 1200);
  a.send({ type: "fragment", fragment: { start_ms: 300, end_ms: 400, delta: "second" } }, 1201);
  a.send({ type: "delegation", id: "d2", offset_ms: 400 }, 1500);
  a.send({ type: "tick" }, 1750);
  expect(a.get("d1")).toMatchObject({ text: "first" });
  expect(a.get("d2")).toMatchObject({ text: "late second", range: { sequences: [1, 2] } });
});

test("continuation after offset is included before boundary; repeated silence does not reset it", () => {
  const a = assembler();
  a.send({ type: "fragment", fragment: { start_ms: 100, end_ms: 200, delta: "tell me" } }, 0);
  a.send({ type: "delegation", id: "d", offset_ms: 100 }, 100);
  a.send({ type: "silence", at_ms: 200, silent: true }, 200);
  a.send({ type: "silence", at_ms: 500, silent: true }, 500);
  a.send({ type: "fragment", fragment: { start_ms: 200, end_ms: 400, delta: " more" } }, 1000);
  expect(a.send({ type: "tick" }, 1100)).toEqual([]);
  expect(a.send({ type: "tick" }, 1250)[0]?.text).toBe("tell me more");
});

for (const [name, count] of [["headset", 4], ["speaker", 5]] as const) {
  test(`real ${name} fixture has ${count} exact requests`, async () => {
    const result = await replay(`tests/fixtures/p0-${name}-${count}-requests.jsonl`);
    expect(result.requestCount).toBe(count);
    expect(result.table.every((r) => r.state === "READY")).toBe(true);
    expect(result.usage[0]?.seconds).toBe(78);
  });
  for (const delayMs of [0, 250, 650, 2000, 10000]) test(`real ${name} survives delay=${delayMs}, duplicates and adjacent reorder`, async () => {
    const result = await replay(`tests/fixtures/p0-${name}-${count}-requests.jsonl`, { delayMs, dup: true, reorder: true });
    expect(result.requestCount).toBe(count);
    expect(result.table.every((r) => r.state === "READY")).toBe(true);
  });
}

test("stragglers are retained and diagnosed once, never glued to a distant request", () => {
  const a = assembler();
  a.send({ type: "silence", at_ms: 0, silent: true }, 0);
  a.send({ type: "fragment", fragment: { start_ms: 0, end_ms: 200, delta: "first" } }, 0);
  a.send({ type: "delegation", id: "d1", offset_ms: 200 }, 900);
  a.send({ type: "tick" }, 1150);
  a.send({ type: "fragment", fragment: { start_ms: 100, end_ms: 200, delta: "word" } }, 1200);
  a.send({ type: "fragment", fragment: { start_ms: 60000, end_ms: 60200, delta: "commit everything" } }, 61000);
  a.send({ type: "delegation", id: "d2", offset_ms: 60400 }, 61500);
  a.send({ type: "tick" }, 61750);
  expect(a.get("d1")).toMatchObject({ text: "first" });
  expect(a.get("d2")).toMatchObject({ text: "commit everything", range: { sequences: [2] } });
  expect(a.snapshot().fragments[1]).toMatchObject({ delta: "word", consumed_by: null, quarantined_for: "d2" });
  expect(a.diagnostics()).toEqual([{ type: "straggler", sequence: 1, delegation_id: "d2" }]);
  a.send({ type: "tick" }, 62000);
  expect(a.diagnostics()).toHaveLength(1);
});

test("without resume evidence, inclusion ends at offset plus 900ms inclusive", () => {
  const a = assembler();
  a.send({ type: "silence", at_ms: 0, silent: true }, 0);
  a.send({ type: "delegation", id: "d1", offset_ms: 1000 }, 100);
  for (const [start_ms, delta] of [[1000, "first"], [1900, " whole"], [1901, "UNRELATED"]] as const)
    a.send({ type: "fragment", fragment: { start_ms, end_ms: start_ms + 200, delta } }, 200);
  expect(a.send({ type: "tick" }, 900)[0]).toMatchObject({ text: "first whole", range: { sequences: [0, 1], end_ms: 2100 } });
  expect(a.snapshot().fragments[2]?.consumed_by).toBeNull();
});

for (const [name, count] of [["headset", 4], ["speaker", 5]] as const) test(`real ${name} contains no invented speech-resume markers`, async () => {
  const rows = (await Bun.file(`tests/fixtures/p0-${name}-${count}-requests.jsonl`).text()).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((r) => r.event.type === "local.silence")).toHaveLength(count);
  expect(rows.filter((r) => r.event.type === "local.silence").every((r) => r.event.silent === true)).toBe(true);
});

for (const gap of [900, 901]) test(`straggler quarantine uses a strict 900ms gap: ${gap}`, () => {
  const a = assembler();
  a.send({ type: "silence", at_ms: 0, silent: true }, 0);
  a.send({ type: "fragment", fragment: { start_ms: 0, end_ms: 200, delta: "first" } }, 0);
  a.send({ type: "delegation", id: "d1", offset_ms: 200 }, 900);
  a.send({ type: "tick" }, 1150);
  a.send({ type: "fragment", fragment: { start_ms: 100, end_ms: 200, delta: "late " } }, 1200);
  a.send({ type: "fragment", fragment: { start_ms: 1000, end_ms: 1100, delta: "second" } }, 1201);
  a.send({ type: "delegation", id: "d2", offset_ms: 200 + gap }, 1500);
  a.send({ type: "tick" }, 1750);
  expect(a.get("d2")).toMatchObject({ text: gap === 900 ? "late second" : "second" });
  expect(a.diagnostics()).toHaveLength(gap === 900 ? 0 : 1);
  a.send({ type: "fragment", fragment: { start_ms: 5000, end_ms: 5100, delta: "third" } }, 5000);
  a.send({ type: "delegation", id: "d3", offset_ms: 5200 }, 5200);
  a.send({ type: "tick" }, 5500);
  expect(a.get("d3")).toMatchObject({ text: "third", range: { sequences: [3] } });
});
