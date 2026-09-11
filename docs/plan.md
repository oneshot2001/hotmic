# FINAL PLAN — Voice bridge for Claude Code (synthesis of Plan A / Fable and Plan B / Astra)

Status: PLAN ONLY. Nothing built. Awaiting Matthew's go.

## Where the two plans agreed (adopted without debate)

- Bun + TypeScript strict, one long-running broker process per Mac, one GPT-Live connection at a time, one MCP channel shim per Claude session over a private unix socket. Sessions launched through a wrapper (`<tool> claude -n <name>`); no hot-attach to an already-running terminal.
- Native macOS audio, no browser required. Companion page deferred.
- `egress.ts` is the single outbound serializer. Nothing else touches the OpenAI socket or key.
- **No `MessageDisplay` hook and no transcript tailing.** That was the leak. Hooks are metadata-only.
- `reply` tool is the only source of result text. `Stop` is lifecycle only. Durable IDs replace the 5-second dedupe window.
- A delegation is never dropped. Late transcript = hold and retry, then ask.
- A correction bumps a revision; the superseded revision's result is never spoken.
- Spoken results are prefixed with the session alias.
- Dependencies: `@modelcontextprotocol/sdk` only. No `ws`, no HTTP framework, no OpenAI SDK, no React.
- MIT license; `NOTICE.md` + README credit Sebastian Sosa's `full_duplex_code` as the prior implementation; no reference code, prompts, tests, or assets copied.

## Where they diverged, and the ruling

| Topic | Plan A (Fable) | Plan B (Astra) | Ruling |
|---|---|---|---|
| Audio capture/playback | sox `rec`/`play` pipes (already installed, zero build) | Swift AVAudioEngine helper with voice processing, 20 ms frames, ≤150 ms output gating | **A first, B if needed.** P0 uses sox. The echo/false-interrupt experiment decides whether the Swift helper is built in P4. Output gating is implemented on the sox playback pipe (kill and clear queue on local speech onset). |
| Privacy default | Per-session levels off/status/summary/full; `summary` = reply text after scrub, default for allowlisted repos | Default-deny; free text requires **exact-text release** (human approves the payload hash locally, TTY keystroke only); repo allowlist is routing permission, not export permission | **B's model, A's convenience as opt-in.** Levels: `off` (default, unknown or AV), `status` (templated lines only), `release` (reply shown locally, spoken only after a serve-pane TTY keystroke), `summary` (reply spoken after scrub; opt-in per session, documented as convenience not confinement). Path containment by realpath component, denied roots override. Vault session starts at `status` because 02-Projects/alpha-vision lives inside it. |
| Name matching | Fuzzy ≥0.8 similarity + sticky last-addressed 90 s | Explicit registered aliases only, no fuzzy; destination captured at utterance start | **B.** Explicit aliases with pronunciation variants in policy. Destination locked at utterance start so a pane switch mid-sentence cannot redirect. A's sticky fallback is kept as B's "pinned" destination ("talk to aar"). |
| Stale speech already in the voice model | Skip the append if revision is newer | Retire the voice epoch: close and reopen seeded only with current authorized state | **Both, tiered.** Revision check before every append (cheap, always). Epoch retirement only when a superseded result was already appended as commentary. |
| Persistence | In-memory state, SQLite ledger only | SQLite for delegations, requests, revisions, deliveries, results, exports, usage; crash reconciliation state | **B, trimmed.** Tables: `sessions`, `requests` (with revision), `deliveries`, `results`, `usage`. `RECONCILE_REQUIRED` state after crash between emit and journal; never auto-rerun. |
| Settle heuristic | 700 ms no new transcript delta, max 4 s hold, 15 s then ask | 650 ms local silence + 250 ms no new fragment; no consumption window; fragment spanning the offset kept intact | **B.** Local silence from the mic stream is a better signal than transcript cadence. The offset-spanning fragment rule comes straight from today's log (the word "about" would have been cut). |
| Hooks installed | Stop, PermissionRequest, Notification, SessionEnd | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SessionEnd, all metadata-only; exec-form; existing hooks preserved | **B.** Metadata-only means the extra events cost nothing and give the state display tool names and turn boundaries. |
| Cost caps | Idle close 4 min, wake hotkey reseeds 8k tokens | $0.50/activation, $3/day, 60 s idle close even while Claude works, mute >15 s closes, no auto-reopen | **B's caps as defaults, A's idle window.** Idle close at 3 min of no user speech, since a 30 s Claude turn plus listening to the answer already exceeds 60 s. No paid auto-reopen; a result arriving to a closed voice is queued and spoken at the next wake. Caps are defaults for Matthew to confirm, not measured authority. |
| Policy file format | TOML (`smol-toml` dep) | JSON | **JSON.** One fewer dependency. |
| Estimate | ~24 h | 33–44 h + 8–12 contingency | **~36 h** (see phases). A underestimated five-session routing and crash reconciliation; B's Swift helper and signed packaging are deferred, which removes most of its contingency. |

## Architecture (final)

```
mic/speaker (sox; Swift helper optional later)
        ↕ pcm16 24k
┌──────────────────────────────────────────────┐
│ broker (Bun)                                  │
│  live.ts        WS, session.start, audio, appends (client_event_id tracked)
│  transcripts.ts utterance records, silence-based settle
│  requests.ts    request/revision/delivery state machine (SQLite)
│  router.ts      alias → session; cmux focus at utterance start
│  egress.ts      THE choke point: level, path containment, scrub, 500-token chunk
│  ledger.ts      usage snapshots (replace, never sum), caps, daily total
│  sock.ts        unix socket hub (0700 dir, per-session capability token)
│  audio.ts       sox spawn, playback queue with gate/clear
└───────┬──────────────────────┬───────────────┘
   shim/channel.ts        shim/hook.ts        (one pair per Claude session)
        │ MCP stdio            │ exec-form hooks, metadata only
   claude -n vault …     claude -n aar …      (normal interactive sessions in cmux panes)
```

## Delegation / request state machine (final)

`WAITING_TRANSCRIPT → WAITING_ROUTE → READY → DISPATCHING → DELIVERED → ACKNOWLEDGED → (WAITING_USER) → RESULT_LOCAL → {EXPORT_BLOCKED | RESULT_AVAILABLE} → SPOKEN`, plus `SUPERSEDED`, `RECONCILE_REQUIRED`, `FAILED`, `CANCELLED`.

- Persist every `delegation.created` before matching. Re-evaluate on every input fragment. At 2 s show "waiting for transcript"; at 8 s ask once; never discard.
- Utterance boundary = 650 ms local silence then 250 ms with no new fragment. Fragment spanning `offset_ms` stays whole. Text already delivered is marked consumed; text after the boundary belongs to the next request.
- Correction words ("actually", "instead", "replace", "cancel", "stop") on an active destination create a revision in one transaction: bump, mark old `SUPERSEDED`, invalidate its results and exports, deliver a correction naming the superseded delivery id. "New task" forces a fresh request. Unclassified follow-ups to the same active destination are held and clarified, not guessed.
- `reply(completed|failed|question)` is terminal per revision; repeats are no-ops. `Stop` without a reply within 3 s → status line "vault finished, result is in the terminal" (no content). This replaces A's last_assistant_message fallback, which would have been an export path.
- Timeouts: 20 s no ack → "delivery unconfirmed" status; 60 s → reconcile prompt; 120 s no result → "still working" once. Nothing is resent automatically.
- Every append carries `request_id + revision`; egress rejects the append if the session's current revision is newer.

## Privacy boundary (final)

`~/.config/<tool>/policy.json`:

```json
{
  "default": "off",
  "denyRoots": ["~/alpha-vision", "~/Second Brain Vault/02-Projects/alpha-vision"],
  "sessions": {
    "vault":     { "root": "~/Second Brain Vault", "level": "status",  "aliases": ["vault", "second brain"] },
    "aar":       { "root": "~/Projects/aar",       "level": "summary", "aliases": ["aar", "a a r"] },
    "edgeproof": { "root": "~/Projects/edgeproof", "level": "release", "aliases": ["edge proof", "edgeproof"] }
  },
  "statusTemplates": ["Sent to {alias}.", "{alias} is still working.", "{alias} needs approval in its terminal.", "{alias} has a result ready in the terminal."]
}
```

- Unknown session, malformed identity, or missing policy → fail closed.
- `summary` scrub runs on the complete assembled payload before chunking: cred-store values, key shapes, absolute paths under denyRoots, per-session redact list. Known-secret prefix/suffix matching requires fragments of at least eight characters; deliberate splitting across three or more replies is out of scope. Documented as a convenience layer; `release` is the confinement layer.
- `release` UI: **TTY keystroke only**. The candidate reply prints in the `hotmic serve` pane; its own `process.stdin` must be a TTY in raw mode. The approve keystroke is bound to the displayed payload hash and revision, held in process memory. No CLI or control-socket approve/reject command exists, and status omits approval hashes. Without a serve TTY, release cannot be approved and status reports that limitation. Voice and Claude tools cannot approve.
- Tests intercept serialized outbound frames and assert zero unauthorized bytes: fragmented secret at every byte boundary, canary read from outside the root and echoed through reply/hooks, symlink and sibling-prefix path escapes, forged session metadata, cross-session reply, revoked release, superseded revision, malformed UTF-8 token.

## Router (final)

Registry: `session_id, adapter_id, alias, root, workspace_uuid, surface_uuid, state, last_heartbeat, level`. Heartbeat 2 s; 6 s silence → unavailable, queued request retained and announced.

Precedence: explicit leading alias → pinned destination ("talk to aar" until "talk to …" again or 5 min) → cmux focused surface captured at utterance start (`cmux identify --no-caller`, caller env vars cleared) → ask, listing live aliases. Names inside task content never re-route. One broker-owned speech queue; questions and permission notices before completed results; progress coalesced.

Native peer messaging (ListAgents/SendMessage) is not in the dependency chain.

## Audio / UX (final)

sox capture at 24 kHz mono pcm16 in 20 ms frames; playback queue 80–120 ms target, 200 ms cap. Local speech onset gates output and clears the queue (target ≤150 ms). Headset first; speaker mode only after the echo experiment passes. Live prompt forbids filler; broker speaks only the four status templates plus results. Cost spoken on close. Broker runs in its own cmux workspace showing session list, state, running cost, and the release prompt; `cmux set-status` mirrors cost.

## Repo layout

```
<tool>/
  bin/<tool>              # serve | claude | wake | sleep | status | usage | doctor
  src/{cli,broker,live,transcripts,requests,router,cmux,egress,ledger,db,audio,protocol}.ts
  shim/{channel,hook}.ts
  config/policy.example.json
  prompts/{live,channel}.txt
  tests/{delegation,revisions,privacy,routing,recovery,ledger}.test.ts + fixtures/
  scripts/{smoke,replay,install.sh}.ts
  docs/{contracts,privacy,acceptance}.md
  LICENSE (MIT) · NOTICE.md (Sosa credit) · README.md
```

Ship as a compiled Bun binary via `install.sh` (checksum verified). First-run steps stay explicit: mic consent, key into the cred store, Claude's channel confirmation.

## Build sequence

| Phase | Work | Acceptance | Hours |
|---|---|---|---:|
| 0 Contract probes + audio spike | `cmux identify` fields from three panes; synthetic channel message reaches a `claude -p` session with existing hooks intact; sox in/out against a live session, transcripts + delegation offsets logged across 20 utterances with deliberate pauses; echo test headset vs speakers. **First paid smoke, cap $0.15.** | Offset-vs-last-fragment distribution recorded; channel works on 2.1.269; echo verdict. | 4 |
| 1 Request correctness offline | `transcripts.ts` + `requests.ts` as pure machines over SQLite; replay harness with synthetic fixtures (today's log kept private, transformed). Delays 0/250/650/2000/10000 ms, duplicates, reorders, crash at each durable boundary. | Zero lost delegations, zero stale results, zero auto-reruns; ledger fixture yields 96 s = $0.08. | 8 |
| 2 Single-session vertical slice | shim pair, launcher, `egress.ts` with policy + tests, status templates, `release` approve path. **Paid smoke #2**: today's 5-step script including the canary read. | End to end on one session; canary never leaves at `off`/`status`/`release`-unapproved; Stop-without-reply yields status only. | 8 |
| 3 Five sessions | registry, aliases, pinned, cmux focus at utterance start, speech queue, cross-session reply rejection. **Paid smoke #3**: 10 fixture requests across 5 sessions. | 10/10 correct destination; ambiguous never dispatches; AV root never registers. | 7 |
| 4 Lifecycle + install | caps, idle close, wake with ≤4 KB seeded state, reconnect with 10 s capture buffer, `doctor`, `usage`, `install.sh`, README + NOTICE. Swift audio helper only if P0 echo test failed. | Fresh-user install in one command; restart preserves caps; every close finalized or marked unconfirmed. | 6 |
| 5 Adversarial acceptance | reviewer agent + Astra finding pass on the diff; one 45-minute real-work session logged; acceptance report. | Report passes the P3 targets (transcript-ready→emit ≤250 ms p95; speech end→emit ≤1.5 s p95; approved result→playback ≤2.5 s p95; interrupt→silence ≤150 ms p95). Claude's own latency reported separately. | 3 |

**Total ~36 h.** Codex builds P0–P4 backend/CLI; Claude reviews every phase, owns the broker pane UI, README, NOTICE, and P5.

## Risks → experiments (merged, deduplicated)

| Risk | Experiment | Phase |
|---|---|---|
| Delegation fires before the sentence ends | 20-utterance offset log with mid-sentence pauses | 0 |
| Channel/hook contract shifts on CLI update | `doctor` pins tested version; probe runs `claude -p` with shim and asserts the `<channel>` prompt | 0, and on every update |
| cmux focus resolves the launcher pane, not the active one | Two windows, two sessions in one workspace, rapid focus changes, env vars cleared | 0 |
| Open-mic echo / false gating | Headset vs speaker traces, 5 min | 0 |
| Repo allowlist mistaken for confinement | Canary file outside root read by Claude and echoed via reply and hooks | 2 |
| `release` review burden makes it unusable | Ten real non-AV tasks at `release`; measure approvals per hour; then decide `summary` per session | 3 |
| Stale facts survive in the voice model | Inject A, supersede with B, instrument played PCM across epoch retirement | 2 |
| Crash between emit and journal reruns side effects | Kill broker/adapter immediately before and after emission | 1 |
| Caps reset on reconnect or crash | Fake-clock snapshots, repeated reconnects, kill during close | 4 |
| Latency stays near today's 30 s | Three identical fixture tasks; attribute delay to Claude vs bridge vs audio; fix only the measured bottleneck | 5 |

## Open decisions for Matthew

1. Confirm default caps: $0.50 per activation, $3 per day, 3 min idle close, mute >15 s closes.
2. Vault session at `status` (safe) or `summary` with an AV-term redact list (convenient)?
3. Repo name.

Content and launch plan: separate document, after P2 proves the slice.
