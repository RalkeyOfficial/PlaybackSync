# Real `nudge-rate` for `SYNC_ADJUST` — Shaping Notes

## Scope

Replace the hard-seek fallback that the extension performs when the daemon sends `SYNC_ADJUST { mode: 'nudge-rate' }`. Instead of jumping, the client should briefly clamp the `<video>.playbackRate` so playback gently converges to the daemon's `targetPos`.

## Decisions

- **Ownership split: runtime owns math, adapter exposes a primitive.** The new contract method `setPlaybackRate(rate: number)` is a thin declarative write-through to the underlying player. All math (delta from `targetPos`, rate selection, restore-timer scheduling, cancellation) lives in `src/adapters/runtime.ts`. One source of truth for the nudge algorithm; one place to clean up the timer.
- **Drop `sync_adjust { delta }` entirely.** The variant was dead: the server never sends a delta field, and every existing emit was `delta: 0` paired with a hard seek. Replaced wholesale by `nudge_rate { targetPos }`.
- **Rate magnitude fixed at ±5%.** `1.05` if behind the room, `0.95` if ahead. The daemon's nudge-rate band is 200–500 ms, so 5% is enough to close most drift within a few seconds without being audible.
- **Restore timer capped at 3 s.** `durationMs = min(|delta| / 0.05, 3000)` — bounds the worst case so a stale `currentPos` can't leave playback nudged indefinitely. If drift persists, the daemon resends and the chain re-arms.
- **Cancel-and-restore on seek/play/pause mid-nudge.** Any subsequent authoritative command while a nudge is in flight clears the timer and writes `playbackRate = 1` before forwarding the command — otherwise a hard seek would land at a clamped rate.
- **No new suppression slot.** `<video>.playbackRate = …` fires `ratechange`, which no adapter listens to. There is no feedback echo to suppress.
- **No tests.** Matches existing extension posture across the prior slices (miruro / WS-client / share-URL-creds / popup all deferred Vitest setup). Verification is `pnpm compile` + manual smoke against a live daemon.

## Context

- **Visuals:** None — internal protocol-handling change with no UI surface.
- **References:** `extension/src/background/session.ts:141-150` (the existing fallback), `extension/src/adapters/miruro/index.ts:124-142` and `extension/src/adapters/_template/index.ts:48-66` (existing `onCommand` switch shape), `extension/src/adapters/runtime.ts:82-85` (the `deliverCommand` interception point).
- **Product alignment:** Last cleanup item before the room-joiner feature surface is fully production-shaped (see [EXTENSION_TODO.md](../../../EXTENSION_TODO.md) §Cleanup/quality). Removes the "deliberately not implemented yet" note from `extension/docs/protocol-client.md`.
- **Future-proofing:** The pending multi-room future (multiple WS sessions in the same browser, one per tab) is a background concern. The runtime is per-content-script, so this design's per-tab nudge state remains correct without changes when multi-room lands.

## Standards Applied

N/A — the standards in `agent-os/standards/index.yml` cover backend PHP conventions, Vue/Nextcloud frontend conventions, and Vite/Nextcloud build tooling. None apply to the browser extension's internal TypeScript modules.
