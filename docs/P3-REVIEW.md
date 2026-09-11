# P3 review findings (Claude reviewer, 2026-09-11) — FIX BEFORE COMMIT

Verified OK: alias-in-content never re-routes; focus captured at first fragment; pin 5-min logic; off-level rules; heartbeat expiry/restore; idempotent migration; speech queue no-interleave and nothing bypasses egress; cross-session reply rejection; smoke never touches the user's policy; no overlap with the reference repo.

## P1 — must fix
1. **Relaunching `hotmic claude -n <alias>` is impossible after the first launch.** `src/cli.ts:99` mints a new token per launch; `src/registry.ts:21` loads persisted rows and `:31` rejects a different token forever, even when the old session is disconnected. Every crash/`/exit`/restart bricks the alias until DB surgery. This is a regression from P2 (which rejected only while connected) and `tests/broker.test.ts:110` was rewritten to bless it. Fix: reject a different token ONLY when the previous registration is connected; otherwise replace `token_hash` (and refs) on re-register. Restore the P2 test. Add a test: register → disconnect → relaunch with new token succeeds; register → still connected → different token rejected.
2. **A pending route-ask swallows the operator's next full request.** `src/broker.ts:96` accepts a non-bare leading alias as the ask answer, so "charlie, New task: … step eight" resolves the OLD pending ask to charlie and cancels step eight. Fix: an ask resolves only on a BARE alias (`named.text === ""`), "that one"/"the focused one", or "cancel"; any other utterance is routed as its own new request and the ask stays pending (re-asked once after the new request is dispatched). Test both.

## P2 — should fix
3. Ledger: state #1 as a regression, not design; name the never-exercised relaunch path in `verification_gap`. Commit the mutation runner under `scripts/mutate.ts` with its log so 64/64 is reproducible, or drop the number.
4. STT punctuation: add `.` to the alias separator set in `src/netcontrol.ts:9,19` so "Aar. Run the tests" routes (keep `...` handling). Test.
5. Report accuracy: the prompt added four things (two acknowledgements, the rewritten live-list ask, and the two availability notices). Say so in the report and in a P3-BRIEF errata line; keep them all (the notices are required by the heartbeat/off rules).
6. Coalescing over-suppresses: only `still_working` is `"progress"`; `waiting` and `unconfirmed` are `"status"` and must not be dropped by the 60 s window. Test: waiting at 2 s then unconfirmed at 20 s → both spoken.

## P3 — cheap
7. Strip "this one," before the pin branch too (`netcontrol.ts:53`).
8. Delete consumed entries from `#fragmentFocus` after capture (`broker.ts:319`).
9. Report: say `off_unregistered_never_delivered` in smoke-multi is a tripwire, not evidence.
10. `broker.ts:355` fake `level:"status"` registry — add an `includeOff` param to `focusedAlias` instead.
11. Name the `11/60*0.05` constant once (`MIN_ACTIVATION_USD`) and import it in both places.
