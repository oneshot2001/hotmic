# hotmic

Talk to your Claude Code sessions while they work. GPT-Live-1 voice, one mic, many terminals.

**Status: pre-alpha. Phase 0 (contract probes + audio spike) in progress. Nothing here is usable yet.**

- Full-duplex voice (OpenAI `gpt-live-1`, client delegation) in front of ordinary interactive Claude Code sessions. Claude stays the driver; the voice is ears and mouth.
- One voice, many sessions: address a session by name or by the cmux pane you are looking at. The router is called *net control*.
- A hard, tested boundary on what text leaves your machine. Default deny.
- Native macOS audio. No browser tab.

Plan: `docs/plan.md`. Credit and prior art: `NOTICE.md`. License: MIT.
