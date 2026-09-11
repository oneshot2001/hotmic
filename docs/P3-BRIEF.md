# P3 — Five sessions: registry, net control router, speech queue (build brief for Codex)

Read `docs/plan.md` (Router section), `docs/P2-REPORT.md` (what exists + smoke #2 findings), `docs/P0-REPORT.md` (cmux probe: focused pane = `cmux identify --no-caller` → `focused.surface_ref` / `focused.workspace_ref`; the launcher's own pane = `identify` → `caller.*`). Bun + TypeScript strict, Bun built-ins only. Do not copy anything from any other project. The router component is called **net control** in docs and log lines.

## Facts to build against
- P2 broker has a one-entry `sessions` Map and a `route` callback that returns the only alias. `src/requests.ts` already supports `AMBIGUOUS` (→ WAITING_ROUTE + ask) and explicit-alias resolution events.
- Smoke #2: a re-spoken request without "New task" was correctly held, but the spoken ask was "Which session?" — wrong wording for that case. It must say "Is that a correction or a new task for {alias}?"
- Policy `aliases` per session are parsed but unused; `statusTemplates` are parsed but the five templates are hard-coded. P3 uses `aliases`; templates stay hard-coded (documented).
- cmux refs are `workspace:N` / `surface:N` strings, not UUIDs. Treat them as opaque, stable-for-the-session keys.

## Deliverables

### 1. `src/registry.ts`
Replace the one-entry Map. Row: `{alias, cwd, token_hash, workspace_ref, surface_ref, level, connected, last_heartbeat}`. Persist in the existing `sessions` table (add columns; migration idempotent). Shim heartbeat every 2 s (`{type:"heartbeat"}` line); 6 s without one → `connected:false`; queued/in-flight requests to that alias are RETAINED and a status line "{alias} is not responding" is spoken once. Reconnect with the same token restores `connected:true`. A second registration for the same alias with a different token is rejected (P2 rule). Maximum 8 sessions.
`hotmic claude -n <alias>` records `workspace_ref`/`surface_ref` from `cmux identify` (caller fields) at launch; if cmux is absent, both null.

### 2. `src/netcontrol.ts` — the router (pure)
`resolve(utterance: {text, spokenAt}, ctx: {registry, pinned, focused}) → {alias} | {ask: string} `. Precedence, exactly:
1. **Explicit leading alias**: the utterance starts with a registered alias or one of its policy `aliases`, followed by a comma/pause/"," or a verb ("aar, run the tests", "edge proof run the tests"). Case-insensitive, exact token match after normalizing spaces; NO fuzzy matching. Strip the alias from the delivered text.
2. **Pinned destination**: "talk to {alias}" / "switch to {alias}" sets `pinned` (spoken confirmation "Talking to {alias}."); expires after 5 min of no requests or on the next "talk to". A pinned alias routes everything without a leading alias.
3. **cmux focus at utterance start**: `focused` is sampled by the broker every 2 s (`cmux identify --no-caller`, caller env vars stripped) and the value captured at `spokenAt` (first input-transcript fragment of the utterance) is used, NOT the value at delegation time. Match on `surface_ref`, then `workspace_ref`; if the focused pane is not a registered session (e.g. the serve pane or a browser), fall through.
4. **Ask**: "Which session? Live: {alias1}, {alias2}, …" — the request stays WAITING_ROUTE and resolves on the next utterance that names one (rule 1) or says "that one"/"the focused one" (rule 3 re-sampled).
Aliases mentioned INSIDE task content never re-route ("ask aar to..." after a leading "vault," goes to vault).
Sessions at policy level `off` are not routable: leading alias → spoken "That session is not available by voice."; focus on it → fall through to ask.

### 3. Correction-vs-new-task ask wording
When P1's hold rule fires (unclassified follow-up to an alias with an in-flight request), the spoken ask is "Is that a correction or a new task for {alias}?" and the next utterance resolves it: starts with "correction"/"yes, correction"/"instead" → correction (revision bump); starts with "new task"/"separate"/"no" → fresh request. Add both to `prompts/live.txt` as the ONLY two additional permitted phrases (list must remain explicit).

### 4. Speech queue (`src/speech.ts`)
One broker-owned queue feeding egress. Priority: questions (`reply status=question`) and permission notices first, then completed/failed results, then status lines; progress coalesced (one "still working" per alias per 60 s). Every spoken result is prefixed "{alias}: " (already true) and every status names the alias. When two results are ready at once, speak them in priority order and never interleave chunks of two payloads.

### 5. `hotmic status` / serve pane
Serve pane shows all sessions: alias | state | connected | focused marker `*` | pending approval count. `hotmic status` JSON adds `pinned`, `focused`, and per-session `connected`.

### 6. Paid smoke #3 `scripts/smoke.ts --paid --scenario multi --max-usd 0.30`
Human-run. Prints: start serve; open FIVE cmux panes each running `hotmic claude -n <alias>` in five disposable repos the script creates under `~/Projects/hotmic-smoke/{alpha,bravo,charlie,delta,echo}` (each with one file), policy entries for all five at `release` (the script writes a temporary policy to `HOTMIC_POLICY` path and prints it; never touches `~/.config/hotmic/policy.json`); wake; then the operator speaks ten requests: 2 with leading alias, 2 after "talk to bravo", 2 by focusing a pane and saying "this one, …" or no target, 1 aimed at a non-registered pane (expect ask), 1 with an alias inside the content, 1 repeat without "New task" (expect the correction/new-task ask, answer "new task"), 1 with a pause. `--grade` asserts: 10/10 correct destination per a printed expected table the operator fills by speaking in order; ambiguous never dispatched; off/unregistered never received a delivery; every spoken result prefixed with the right alias; cost ≤ cap, finalized.

### 7. Tests
`tests/registry.test.ts` (heartbeat expiry/restore, retained requests, token rejection, max 8), `tests/netcontrol.test.ts` (each precedence rule, alias-in-content, off-level, pinned expiry, focus captured at spokenAt not at delegation, ask resolution by "that one"), `tests/speech.test.ts` (priority, no interleave, coalescing), broker integration with 3 fake shims (deliveries go to the right shim; cross-session reply rejected; disconnect retains + announces once). Mutation-check each guard (remove it, test must fail) and list the results in the report.

## What you may run
`bun test`, `bunx tsc --noEmit`, `bun scripts/replay.ts …`, `cmux identify` (read-only). NOT `hotmic wake`, nothing paid, no `claude` sessions.

## Done means
All tests green, typecheck clean, `docs/P3-REPORT.md` with module map, precedence table with test names, mutation results, smoke #3 procedure, honesty ledger (`changed / related_untouched / noticed_not_fixed / residual_uncertainty / verification_gap`), commit groups. Do not commit.

## Review errata (2026-09-11)

The prompt requires four additions/changes: the two acknowledgement forms (pin confirmation and correction/new-task question), the rewritten live-list ask, and the two availability notices as one group (`{alias} is not responding`; `That session is not available by voice.`). This corrects “ONLY two additional permitted phrases”; retain all forms because heartbeat/off rules require the notices. A pending destination ask resolves only on a bare alias, “that one”/“the focused one”, or “cancel”; a full addressed request is independent and the pending ask is repeated once after that request dispatches. Different registration tokens are rejected only while connected; disconnected relaunch rotates the capability and refs.
