# P0 report

Run date: 2026-09-11. Phase 0 implementation is complete; live contract acceptance remains blocked by sandbox socket permissions, and audio measurements await the human runs.

## Offline verification

Commands:

```sh
bun test
bunx tsc --noEmit
bun build --target=bun --outdir .runs/p0/build shim/channel.ts shim/hook.ts scripts/probe-cmux.ts scripts/probe-channel.ts scripts/spike-audio.ts
```

Result: **PASS** — 8 tests, 64 assertions; strict TypeScript check exits 0; all five entry points bundle successfully. Tests cover arbitrary 960-byte frame boundaries, synthetic RMS and 300 ms silence/reset, 96 s = $0.08, close-budget reservation, fragmented transcript words, metadata filtering, and MCP framing/forwarding/error responses over an in-process pipe. Bundling only compiles the audio spike; no microphone or paid audio connection was opened.

Environment: Bun 1.3.5; TypeScript 5.9.3; `@types/bun` / `bun-types` 1.3.14; `@types/node` 25.5.0; `undici-types` 7.18.2. Package downloads were blocked (`ConnectionRefused` / `FailedToOpenSocket`), so these development dependencies were copied from the existing local Bun cache into ignored `node_modules`. No runtime dependencies were added. On a normal networked machine, use `bun install` first.

## cmux probe

Command:

```sh
bun --no-env-file scripts/probe-cmux.ts
```

What to look for: raw output from `identify`, `identify --no-caller` with all `CMUX_*` variables removed, `workspace status`, and `list-windows`. Compare the workspace/surface field paths while switching focused panes and windows. The summary lists observed field paths as candidates, not a proven routing contract.

Result (Codex sandbox): BLOCKED, socket denied. Result (re-run by Claude outside the sandbox, `.runs/p0/cmux-1789159563584.json`): **PASS**. `cmux identify --no-caller` returns `focused.{workspace_ref, surface_ref, pane_ref, tab_ref, window_ref, surface_type, is_browser_surface}` and `caller: null`; plain `identify` fills `caller.*` with the same shape for the invoking pane. `list-windows` exposes window UUID + `selected_workspace` UUID. So: **focused = `identify --no-caller` → `focused.surface_ref` / `focused.workspace_ref`**; the launcher's own pane = `identify` → `caller.*`. Refs are `workspace:N` style, not UUIDs; UUID mapping via `list-windows`/workspace listing is a P3 detail.

Human: run this from three different cmux panes and once from a plain Terminal. Include two windows and two surfaces in one workspace, then change focus and compare. Run the script by absolute path or `cd` to this repo first.

Confirmed focused-surface/workspace fields: `focused.workspace_ref`, `focused.surface_ref` (from `identify --no-caller`). Still to confirm by human: stability while switching panes/windows, and the caller-vs-focused split from three different panes.

## Channel and metadata hooks probe

Command:

```sh
bun --no-env-file scripts/probe-channel.ts
```

What to look for: version pin, one synthetic notification, `acknowledge`, a `reply` containing the exact marker and `completed` status with matching IDs, metadata-only hook events including SessionStart, and the marker in Claude's final JSON `result`. The marker is absent from the initial prompt, so the result cannot pass merely by echoing that prompt.

Installed version: **2.1.269 (Claude Code)**, matching the plan.

Result (Codex sandbox): BLOCKED, listener `EPERM`. Result (Claude, outside sandbox, four runs, latest `.runs/p0/channel-1789159743790.jsonl`): **channel delivery in `-p` mode: NOT DELIVERED.** The MCP server connects (`system.init` lists `hotmic` connected and both tools), the shim writes a correct `notifications/claude/channel` line (verified standalone), hooks arrive metadata-only, but Claude never sees the `<channel>` event: not when sent before the first turn, not when sent while idle after `end_turn` with `--input-format stream-json` keeping the process alive (waited 60 s), and not when a nudge user turn followed the notification. Claude's own words on the nudge turn: "No hotmic channel message has arrived yet." The docs say events queue and are "delivered together on the next turn"; that did not happen under `-p`. Today's real run of the reference bridge (interactive `claude`, same flag) DID deliver. Working hypothesis: **channel delivery is interactive-session only on 2.1.269, or `-p` requires something undocumented.** The probe now has a `--serve` mode that prepares configs and waits while a human runs the printed interactive `claude` command in a cmux pane; that is the P0 acceptance run.

| Assertion printed by probe (`-p` mode, run 4) | Result |
| --- | --- |
| One notification sent | PASS |
| Acknowledge received | FAIL (never delivered to Claude) |
| Reply contains exact marker | FAIL (same) |
| Hooks received with metadata only | PASS (SessionStart, UserPromptSubmit, Stop, SessionEnd; no text fields) |
| Delivered without a nudge turn | FAIL |
| Claude result mentions marker | FAIL |
| Existing user SessionStart hooks still fire | Observable now: `--verbose` stream emits `system/hook_started` per hook; run 4 shows four SessionStart hooks firing (user's two + ours). Assertion not yet wired. |

Interactive acceptance (`--serve`, `.runs/p0/channel-1789160429562.jsonl`, human ran the printed command in a cmux pane): **PASS.** Idle delivery with no nudge: notification → `acknowledge` **3.9 s** → `reply` with the exact marker and `status: completed` **7.6 s** (Fable 5.1 at low effort). Claude's startup banner printed "server:hotmic · no MCP server configured with that name" and the channel still delivered; treat that line as cosmetic on 2.1.269. Hooks assertion was FALSE in this run for a probe bug, not a Claude one: the hook relay read the socket path from `HOTMIC_SOCK`, which the interactive shell did not have. Fixed: the socket path is now passed as a hook argument. Re-verify hooks in the next interactive run.

The user's settings contain two SessionStart hook entries. They were read only to count entries, never changed or copied into the probe settings. `claude --help` exposes no effective-settings dump, so the probe documents this verification limitation. It leaves user settings enabled and uses an additive `--settings` file. Seeing the probe's own SessionStart is not evidence that the user's hooks fired. A human must check the existing hooks' normal observable effects during the rerun; **channel compatibility with existing hooks intact is not yet established**.

Prototype wire contract: channel socket traffic is JSON lines; hooks use HTTP POST `/hook` on the same Unix socket and return `{}` on hook stdout. Both tools require `request_id`, positive integer `revision` (starting at 1), `delivery_id`, and `session_alias`; `reply` also requires string `text` and `status` in `completed|failed|question`. The plan names these concepts but supplies no full JSON schemas, so these are the explicit P0 schemas. Notification metadata converts IDs/revision to strings for Claude's channel attributes. Tools reject unknown names, extra arguments, and malformed identities. This is not the later authenticated broker or durable request state machine.

Hook export is restricted to string `session_id`, `hook_event_name`, `tool_name`, `turn_id`, `message_id`, `parent_message_id`, and `tool_use_id`. Prompt, transcript paths, assistant output, input/output tool payloads, and all other fields are omitted. Exec hooks cover the eight events in the P0 brief; not all eight necessarily occur in a successful synthetic run.

## Audio spike

Command: see the exact capped commands below.

What to look for: `session.started` before microphone capture, audible playback, input/output transcript deltas, `session.delegation.created` and `delegation_timing` rows, commentary after 900 ms, final `session.closed` usage, and the printed timing table. Logs omit audio payloads and retain other events under `.runs/p0/audio-<timestamp>.jsonl` with monotonic `at` milliseconds. Server error events print verbatim and terminate the run; there is no fallback to guessed fields or another model.

Each timing row contains the server `offset_ms`, arrival-time milliseconds since the latest input fragment, `offset_minus_last_fragment_end_ms` on the server timeline, and elapsed local silence only when normalized PCM RMS stays below 0.015 for at least 300 ms. These are different measurements; preserve that distinction when summarizing the distribution. The spike snapshots the transcript available at each delegation, then echoes it 900 ms later. Late fragments remain for the next delegation; production settling is deferred to P1.

The cap reserves 10 seconds for close plus 1 second margin against **both** `--max-seconds` and the budget at $0.05/min. Defaults therefore request close within 79 seconds of connection setup, with a hard local cutoff before 90 seconds. Usage snapshots replace earlier snapshots; they are never summed. If final usage is missing, the summary labels the last snapshot or wall-clock estimate as unconfirmed. Local timers cannot establish the final server charge after a transport failure.

Result:

Run 1 (headphones, defaults, `.runs/p0/audio-1789161069501.jsonl`): 76 s, $0.063, no requests spoken → 0 delegations, transcripts clean. Confirms mic in / voice out / close handshake / usage reconciliation.

Run 2 (headphones, `--echo-test`, `.runs/p0/audio-1789161316803.jsonl`): 78 s, $0.065, **4 delegations, 4/4 captured exactly**:

| # | offset − last fragment end | since last fragment (arrival) | since local silence | captured |
|---|---:|---:|---:|---|
| 0 | −200 ms | 1.19 s | 1.37 s | "Add a subtract function to calc dot py, run the test, and tell me what failed" (two requests spoken back to back, one delegation; 1.8 s pause inside) |
| 1 | 1800 ms | 2.14 s | 3.26 s | "Open. Open the, read me the summary of it" (**4.0 s and 1.8 s mid-sentence pauses did NOT split the request**) |
| 2 | 800 ms | 1.15 s | 2.35 s | "Rename the add function to plus" |
| 3 | 2000 ms | 2.33 s | 3.48 s | "Commit everything with the message test" |

Delegation-offset versus last-fragment distribution (n=9 across both runs, mid-sentence pauses up to 4 s): the model waits **0.8–2.0 s of silence after the last transcript fragment** before delegating (one case simultaneous, −200 ms). Arrival at the client is 1.2–2.3 s after the last fragment. The "delegation fires before the sentence ends" risk did not appear; the plan's 650 ms + 250 ms settle rule is safe with margin. Note: sox reported the headset can't do 24 kHz and captured at 48 kHz with internal resample; transcripts were unaffected.

Filler despite "No filler phrases" in instructions: "Okay, I'll take care of it." / "Sure, I'll give you the summary." / "Alright, I'll go do that." / "No problem, I'll handle it." → the live prompt needs an explicit allowed-phrase list, not a prohibition (P1/P2).

Headset echo result: no repeated words observed; none expected on a headset.

Speaker echo / false-interruption result (Mac speakers + built-in mic, `--echo-test`, `.runs/p0/audio-1789161673272.jsonl`): **PASS by data.** 78 s, $0.065, **5/5 requests captured exactly**; offset − last fragment end 0.4–1.0 s; arrival 0.8–1.3 s after last fragment; local silence 2.0–2.7 s before delegation; a 2 s mid-sentence pause survived. Echo heuristic: zero repeated words in input within 3 s of any output transcript, so the model's own speech (including the spoken "Got it: …" echoes of the requests) did not leak back through the built-in mic. Human listening verdict: pending. Speaker mode is viable on the Mac Studio; headset stays recommended in the README until a noisier room is tested.

The optional echo check flags repeated completed output words in input within three seconds of transcript arrival. Words split across deltas are assembled; a final word without a delimiter remains pending. It is a diagnostic heuristic, not acoustic echo cancellation or an automatic pass verdict. Listen for speaker feedback and false interruptions, and inspect candidate events. No production playback gating or Swift helper is included in P0.

## How to run the paid spike

Run in this repo from a microphone-enabled terminal. Supply `OPENAI_API_KEY` through the environment; do not use an `.env` file. For an interactive zsh session, this reads it without echoing or putting the key in command history:

```sh
read -s 'OPENAI_API_KEY?OpenAI API key: '
export OPENAI_API_KEY
printf '\n'
command -v rec
command -v play
```

Select the headset input/output in macOS, then run:

```sh
bun --no-env-file scripts/spike-audio.ts --max-seconds 90 --max-usd 0.15 --echo-test
```

Speak short synthetic requests with deliberate pauses. Collect 20 utterances across additional explicitly started capped runs if needed. Then select speakers and the intended microphone and repeat the same command to compare echo. Each invocation has its own cap; there is no daily ledger in P0. Ctrl-C requests graceful close and waits at most ten seconds. Record the final usage, audio artifact filenames, timing distribution, and listening verdicts in the blank result fields above.

After the experiments:

```sh
unset OPENAI_API_KEY
```

## P0 exit questions

| Question | Current answer |
| --- | --- |
| Delegation offset versus last-fragment distribution? | n=9: −0.2 to +2.0 s after last fragment end (median ~0.8 s); pauses up to 4 s inside a sentence did not split it. Settle rule safe. **P0 EXIT: all four questions answered.** |
| Channel works on this Claude version with existing hooks intact? | **Interactive: PASS** (ack 3.9 s, reply 7.6 s, idle delivery). `-p`: NO delivery. Hooks metadata-only: PASS in `-p`; interactive re-check pending after the socket-arg fix. User hooks: observed firing in the `-p` stream, assertion not wired. |
| Which cmux field identifies the focused surface? | `identify --no-caller` → `focused.surface_ref` / `focused.workspace_ref`. Multi-pane stability pending. |
| Headset versus speaker echo verdict? | Both clean (0 echo candidates). Swift audio helper NOT needed for P1–P3; sox path holds. |

## Review findings carried into P1 (Claude reviewer pass, 2026-09-11)

Fixed in P0 before commit: tool `revision` schema now a digit string (channel meta is strings, Claude copies it verbatim); temp run dir cleanup; `.runs-codex-*.log` ignored; one log key renamed to avoid a line identical to the reference. Deferred to P1: SIGINT race in spike (`rec`/`play` share the process group, `exited` can fire before the signal handler and mislabel the close reason); enforce `--no-env-file` via shebang or refuse when `.env` exists; set `finalized` before validating `usage.seconds` on `session.closed`; pin `protocolVersion` in `initialize`; wire the `hook_started` count assertion for user hooks.

## Local commits

Codex's sandbox could not write `.git`; Claude committed after review.

## Contract references

Implementation checked against the supplied `docs/refs/voice-websockets.md`, `live-conversations.md`, and `live-delegation.md`, plus the official [Live WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets?api=live) and [session guide](https://developers.openai.com/api/docs/guides/live-conversations). Channel capability, string metadata, and exec-hook format follow the [Claude channels reference](https://code.claude.com/docs/en/channels-reference) and [hooks reference](https://code.claude.com/docs/en/hooks). These sources establish the intended wire contracts, not evidence of a successful live probe.
