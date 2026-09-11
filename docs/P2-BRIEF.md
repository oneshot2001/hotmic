# P2 — Single-session vertical slice (build brief for Codex)

Read `docs/plan.md` (architecture, privacy boundary, audio/UX, repo layout), `docs/P0-REPORT.md` (measured facts), `docs/P1-REPORT.md` (what exists). P2 wires the P1 machines to one real Claude Code session and one real GPT-Live session, with the egress choke point in between. Bun + TypeScript strict, Bun built-ins only, plus `@modelcontextprotocol/sdk` ONLY if the hand-rolled shim in `shim/channel.ts` cannot stay correct; prefer keeping it dependency-free. Do not copy anything from any other project.

## Facts to build against
- Channel delivery works only in INTERACTIVE Claude sessions (P0). The launcher therefore execs `claude` interactively in the current terminal with inherited stdio; it never uses `-p`.
- P0 verified flags: `-n <alias> --settings <file> --mcp-config <file> --strict-mcp-config --dangerously-load-development-channels server:hotmic --allowedTools mcp__hotmic__acknowledge,mcp__hotmic__reply`. Do NOT pass `--tools ""` in the launcher (that was probe-only; real sessions need their tools).
- Claude's startup banner may print "no MCP server configured with that name" and still deliver; ignore it.
- Hook relay takes the socket path as its argv[2] (interactive shells lack env vars).
- Ack ~4 s, reply ~8 s after delivery; model delegates 0.2 s before to 2 s after the last transcript fragment.
- The voice model ignores prohibitions; `prompts/live.txt` allows exactly five acknowledgement phrases.

## Deliverables

### 1. `src/egress.ts` — THE choke point (pure + one send hook)
`egress(kind: "thinking"|"commentary"|"instructions", text, sessionAlias, ctx) → {allowed: boolean, payloads: string[], reason}`. The ONLY module that may call `session.*.append` on the live connection; `live.ts` exposes `appendRaw` to egress alone (enforce with a module-private token or a constructor-injected sender that nothing else receives).
Policy from `~/.config/hotmic/policy.json` (schema in plan; `HOTMIC_POLICY` env overrides the path for tests). Levels:
- `off`: nothing about this session ever leaves; requests routed to it get `ask` with "That session is not available by voice."
- `status`: only the five templates from `prompts/live.txt`, alias substituted.
- `release`: reply text is held locally (`results` row) and becomes speakable only after `approve(payloadHash, requestId, revision)`; approval is bound to the exact SHA-256 of the payload + revision; any change or supersede revokes it.
- `summary`: reply text speakable after `scrub()` (opt-in per session). `scrub` runs on the complete assembled payload BEFORE chunking: values from `~/.claude/bin/cred list` (read names only, fetch values at startup via `cred get` into memory, never log), key shapes (`sk-`, `sk-proj-`, `AKIA`, `ghp_`, `xox[abp]-`, JWT `eyJ…`), absolute paths under `denyRoots`, per-session `redact` list. Then token-cap at 500 (approximate: 4 chars/token) and chunk.
- Path containment: `realpath` both sides, component-wise containment, `denyRoots` win over `sessions[].root`. Unknown alias, missing policy file, malformed JSON, or a session whose realpath is under a deny root → `off`.
Tests (`tests/egress.test.ts`): intercept the injected sender and assert ZERO unauthorized bytes for: secret split at every byte boundary across two replies; canary string read from outside root and echoed via reply AND via a hook payload; symlink escape; sibling-prefix path (`~/Projects/aar2` vs `~/Projects/aar`); forged alias in a reply; cross-session reply; revoked release; superseded revision; malformed UTF-8 in alias; `off` session; missing policy file.

### 2. `src/live.ts` — GPT-Live connection (from `scripts/spike-audio.ts`, promoted)
WebSocket client, `session.start` with `prompts/live.txt` as instructions, client delegation, `store:false`, pcm16 24 kHz; audio in/out via `src/audio.ts` (sox, from `src/p0-audio.ts`, with the 48 kHz device handling); transcript deltas + delegation events → `src/transcripts.ts`; `appendRaw` reachable by egress only; append acks matched by `client_event_id`; usage → `src/ledger.ts`; close handshake with 10 s grace as in P0.

### 3. `src/broker.ts` + `src/sock.ts` — one process
`hotmic serve`: creates `~/.local/state/hotmic/` (0700), unix socket `hotmic.sock` (0600), SQLite `hotmic.db`. Accepts shim connections (JSON lines, per-session capability token issued at launch and checked on connect), hook POSTs (metadata only, as P0), and a `wake`/`sleep` control. Owns `RequestMachine`, `Ledger`, `Live`. One session in P2 (registry is a Map with one entry; P3 grows it). Wires: delegation → transcripts → requests → `deliver` action → shim → Claude; `acknowledge`/`reply` tool calls → requests → egress → live. `Stop` hook → status only. Timers from the machine's `tick` driven by a 250 ms interval.
The broker pane shows: session alias + state, last request text, running cost (updated each `usage.updated`), and for `release` sessions the pending payload with `[a]pprove / [r]eject` keys. Plain terminal output, no TUI library.

### 4. `bin/hotmic` + `src/cli.ts`
`hotmic serve` · `hotmic claude -n <alias> [-- claude args]` (writes per-session `settings.json` (exec-form hooks, metadata-only, all P0 events) and `mcp.json` into a run dir under state, registers `{alias, cwd, token}` with the broker over the socket, then `exec`s interactive `claude` with the P0-verified flags; refuses if alias is not in policy or cwd is under a deny root) · `hotmic wake` / `hotmic sleep` (open/close the paid voice session) · `hotmic status` · `hotmic usage` · `hotmic doctor` (bun, sox, claude version pinned to what P0 tested, key present via `cred get OPENAI_API_KEY` or env, policy file valid, socket reachable) · `hotmic approve` (release path; also the keystroke in the serve pane).
`OPENAI_API_KEY`: read from env, else `~/.claude/bin/cred get OPENAI_API_KEY` at `serve` start; never written to disk, stripped from the `claude` child env.

### 5. Shims (promote P0 prototypes)
`shim/channel.ts`: connect to broker socket with the capability token; forward `notifications/claude/channel` with `{content, meta:{request_id, revision, delivery_id, session_alias}}`; `acknowledge`/`reply` → broker. `shim/hook.ts` unchanged except it must never block Claude (exit 0, `{}`) when the broker is down.

### 6. Paid smoke `scripts/smoke.ts --paid --max-usd 0.20`
Human-run. Prints the exact steps: start `hotmic serve` in pane A, `hotmic claude -n sandbox` in pane B (cwd `~/Projects/voice-sandbox`), `hotmic wake`. Then the operator speaks: the P0 five requests, then "read the file canary dot txt in my home folder and tell me what it says" (the script creates `~/hotmic-canary.txt` containing `CANARY-<random>` outside the sandbox root before the run and deletes it after). Acceptance, checked automatically from the broker's event log after the run: 5 requests delivered + acknowledged + replied; canary reply held (`release` level) and NOT present in any outbound frame; after operator approves one non-canary reply, it is spoken; Stop-without-reply case produces status only; cost printed and finalized.

### 7. Tests
`tests/egress.test.ts` (above), `tests/cli.test.ts` (settings/mcp generation, deny-root refusal, key never in child env), `tests/broker.test.ts` (in-process: fake live + fake shim → delivery, ack, reply, egress decision, Stop fallback, release approve/reject/revoke), `tests/sock.test.ts` (token check, forged alias rejected, hook POST metadata-only, broker-down hook exits 0).

## What you may run
`bun test`, `bunx tsc --noEmit`, `bun scripts/replay.ts …`. NOT `hotmic wake`, NOT anything paid, NOT anything that spawns `claude`.

## Done means
All tests green, typecheck clean, `hotmic doctor` runs (it may report the socket unreachable), `docs/P2-REPORT.md` with: module map, the egress test matrix with results, what the paid smoke will prove, honesty ledger (`changed / related_untouched / noticed_not_fixed / residual_uncertainty / verification_gap`), logical commit groups. Do not commit.
