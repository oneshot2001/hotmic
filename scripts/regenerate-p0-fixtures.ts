import { resolve } from "node:path";

// Local, offline provenance tool. Keep expected texts as independent assertions;
// never derive them from the assembler or invent speech-resume transitions.
for (const [name, count, source] of [
  ["headset", 4, "audio-1789161316803.jsonl"],
  ["speaker", 5, "audio-1789161673272.jsonl"],
] as const) {
  const target = resolve(import.meta.dir, `../tests/fixtures/p0-${name}-${count}-requests.jsonl`);
  const expected = (await Bun.file(target).text()).trim().split("\n")
    .map((line) => JSON.parse(line)).filter((row) => row.event.type === "replay.expect");
  const raw = (await Bun.file(resolve(import.meta.dir, `../.runs/p0/${source}`)).text()).trim().split("\n")
    .map((line) => JSON.parse(line));
  const rows = raw.flatMap<{ at: number; event: Record<string, unknown> }>(({ at, event: e }) => {
    let event;
    switch (e.type) {
      case "session.started": event = { type: e.type, client_event_id: e.client_event_id }; break;
      case "session.input_transcript.delta": event = { type: e.type, start_ms: e.start_ms, end_ms: e.end_ms, delta: e.delta }; break;
      case "session.delegation.created": event = { type: e.type, offset_ms: e.offset_ms, delegation: e.delegation }; break;
      case "session.usage.updated": case "session.closed": event = { type: e.type, usage: e.usage }; break;
      case "delegation_timing": {
        if (typeof e.since_silence_ms !== "number") throw new Error("Missing final-silence evidence");
        const at_ms = Math.round((e.at - e.since_silence_ms) * 1000) / 1000;
        return [{ at: at_ms, event: { type: "local.silence", at_ms, silent: true } }];
      }
      default: return [];
    }
    return [{ at: Math.round(at), event }];
  });
  if (expected.length !== 1 || rows.filter((row) => row.event.type === "local.silence").length !== count)
    throw new Error(`Incomplete provenance for ${name}`);
  await Bun.write(target, [...rows, ...expected].sort((a, b) => a.at - b.at).map((row) => JSON.stringify(row)).join("\n") + "\n");
}
