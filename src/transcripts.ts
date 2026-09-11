export type Fragment = { start_ms: number; end_ms: number; delta: string };
type StoredFragment = Fragment & { sequence: number; arrived_at: number; consumed_by: string | null; late_after: string | null; quarantined_for: string | null };
export type TranscriptDiagnostic = { type: "straggler"; sequence: number; delegation_id: string };
const SETTLE_MS = 900;
export type Assembly = {
  id: string; text: string;
  range: { start_ms: number; end_ms: number; sequences: number[] };
};
export type TranscriptState = {
  fragments: StoredFragment[];
  silences: { at_ms: number; silent: boolean }[];
  delegations: { id: string; offset_ms: number; arrived_at: number; assembly: Assembly | null }[];
};
export type TranscriptEvent =
  | { type: "fragment"; fragment: Fragment }
  | { type: "silence"; at_ms: number; silent: boolean }
  | { type: "delegation"; id: string; offset_ms: number }
  | { type: "tick" };

export const emptyTranscripts = (): TranscriptState => ({ fragments: [], silences: [], delegations: [] });

// Arrival/silence clocks are local; fragment ranges and offsets are server time.
// Never compare the two clocks or split a delta at the delegation offset.
export function transcriptStep(previous: TranscriptState, event: TranscriptEvent, now: number) {
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid clock");
  const state = structuredClone(previous);
  switch (event.type) {
    case "fragment": {
      const f = event.fragment;
      if (![f.start_ms, f.end_ms].every((v) => Number.isFinite(v) && v >= 0) || f.end_ms < f.start_ms || typeof f.delta !== "string") throw new Error("Invalid fragment");
      const closed = state.delegations.find((d) => d.assembly && f.start_ms <= d.offset_ms + SETTLE_MS);
      state.fragments.push({ ...f, sequence: state.fragments.length, arrived_at: now, consumed_by: null,
        late_after: closed?.id ?? null, quarantined_for: null });
      break;
    }
    case "silence":
      if (!Number.isFinite(event.at_ms) || event.at_ms < 0 || event.at_ms > now || typeof event.silent !== "boolean") throw new Error("Invalid silence");
      state.silences.push({ at_ms: event.at_ms, silent: event.silent });
      state.silences.sort((a, b) => a.at_ms - b.at_ms);
      state.silences = state.silences.filter((s, i, all) => i === 0 || s.silent !== all[i - 1]!.silent);
      break;
    case "delegation":
      if (!event.id || !Number.isFinite(event.offset_ms) || event.offset_ms < 0) throw new Error("Invalid delegation");
      if (!state.delegations.some((d) => d.id === event.id)) {
        state.delegations.push({ id: event.id, offset_ms: event.offset_ms, arrived_at: now, assembly: null });
        state.delegations.sort((a, b) => a.offset_ms - b.offset_ms || a.arrived_at - b.arrived_at);
      }
      break;
    case "tick": break;
    default: throw new Error("Unknown transcript event");
  }
  const ready: Assembly[] = [];
  const diagnostics: TranscriptDiagnostic[] = [];
  for (const delegation of state.delegations) {
    if (delegation.assembly) continue;
    for (const f of state.fragments) {
      if (f.consumed_by === null && f.quarantined_for === null && f.late_after !== null &&
        f.end_ms < delegation.offset_ms - SETTLE_MS) {
        f.quarantined_for = delegation.id;
        diagnostics.push({ type: "straggler", sequence: f.sequence, delegation_id: delegation.id });
      }
    }
    // Retain historical silence when transcript arrival is delayed past new speech.
    const quietIndex = state.silences.findIndex((s, i) => s.silent &&
      (state.silences[i + 1]?.at_ms ?? Infinity) >= Math.max(s.at_ms + 650, delegation.arrived_at));
    const quiet = state.silences[quietIndex];
    if (!quiet || now < quiet.at_ms + SETTLE_MS || now < delegation.arrived_at + 250) continue;
    const speechResumed = state.silences[quietIndex + 1]?.at_ms ?? Infinity;
    const earlierPending = state.delegations.filter((d) => !d.assembly && d.offset_ms < delegation.offset_ms);
    // Offsets keep delayed old utterances apart from new speech. They are not
    // a text truncation point: a continuation received before speech resumes
    // is included, even when its start lies after the offset. Without observed
    // resumption, cap its start at offset + settle while keeping the delta whole.
    const fragments = state.fragments.filter((f) => f.consumed_by === null && f.quarantined_for === null &&
      !earlierPending.some((d) => f.start_ms <= d.offset_ms) &&
      (f.start_ms <= delegation.offset_ms || (Number.isFinite(speechResumed)
        ? f.arrived_at < speechResumed : f.start_ms <= delegation.offset_ms + SETTLE_MS)))
      .sort((a, b) => a.start_ms - b.start_ms || a.sequence - b.sequence);
    if (!fragments.length || now - Math.max(...fragments.map((f) => f.arrived_at)) < 250) continue;
    const text = fragments.map((f) => f.delta).join("").trim();
    if (!text) continue; // An empty delegation remains eligible forever.
    for (const fragment of fragments) fragment.consumed_by = delegation.id;
    const assembly: Assembly = { id: delegation.id, text, range: {
      start_ms: Math.min(...fragments.map((f) => f.start_ms)),
      end_ms: Math.max(...fragments.map((f) => f.end_ms)), sequences: fragments.map((f) => f.sequence),
    } };
    delegation.assembly = assembly;
    ready.push(assembly);
  }
  return { state, ready, diagnostics };
}

export function assembled(state: TranscriptState, id: string): Assembly | "NOT_READY" {
  return state.delegations.find((d) => d.id === id)?.assembly ?? "NOT_READY";
}
