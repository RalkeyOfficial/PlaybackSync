# Real `nudge-rate` for `SYNC_ADJUST`

## Context

When the sync daemon detects 200–500 ms of drift on a client, it sends `SYNC_ADJUST { mode: 'nudge-rate', targetPos }`. Today the extension falls back to a hard seek, which is jarring — exactly what `nudge-rate` exists to avoid. The fix is to clamp the video's `playbackRate` for a short window so playback gently converges to `targetPos` instead of jumping.

The protocol schema, decoder, command dispatch, and feedback-loop suppression are all already in place. The missing pieces are:

1. An adapter affordance for setting playback rate (the `<video>` is owned by the adapter, not the runtime).
2. A command variant the server-frame folder can emit and the runtime can act on.
3. The actual nudge math + timer.

A note for the future: a later iteration of the extension will support multiple rooms in the same browser (across different tabs). This doesn't change anything in the content-script runtime — each tab still has at most one adapter — but the design below keeps nudge state strictly per-tab so multi-room support remains a background-only concern.

## Approach

**Ownership split:**

- **Adapter** exposes a thin declarative primitive: `setPlaybackRate(rate: number): void`. Each adapter writes through to its `<video>.playbackRate`. No math, no timer.
- **Runtime** (`src/adapters/runtime.ts`) owns the nudge math and the restore timer. It reads `adapter.getState().currentPos`, computes `delta = targetPos - currentPos`, picks a rate, calls `setPlaybackRate`, and schedules the restore. One source of truth for math, one place for cleanup.
- **Session** (`src/background/session.ts`) emits a new `nudge_rate` command for `mode === 'nudge-rate'`.

**Dead code removal:** The `sync_adjust { delta }` command variant is dropped. The server never sends a delta field; every existing emit is `delta: 0` paired with a hard seek. Replaced wholesale by `nudge_rate`.

**Nudge parameters:**

- Rate magnitude: `±5%` (`1.05` if behind, `0.95` if ahead).
- Restore timer: `min(|delta| / 0.05, 3000)` ms — bounded so a misestimate can't leave playback nudged indefinitely.
- If another nudge or seek lands mid-window, the existing timer is cancelled and rate is restored before re-applying. Sequential nudges (the daemon resends every few seconds until drift converges) chain naturally.
- On adapter teardown the runtime cancels the timer and asks the (about-to-die) adapter to restore rate to 1 best-effort.

**Suppression:** `<video>.playbackRate = ...` fires `ratechange`, which no adapter listens to. No echo, no new suppression slot needed.

## Critical files

- [extension/src/adapters/types.ts](../../../extension/src/adapters/types.ts) — add `setPlaybackRate` to `Adapter`; remove `sync_adjust` and add `nudge_rate` to `AuthoritativeCommand`.
- [extension/src/adapters/runtime.ts](../../../extension/src/adapters/runtime.ts) — intercept `nudge_rate` before forwarding to adapter; own the timer; clear on teardown.
- [extension/src/background/session.ts](../../../extension/src/background/session.ts) — rewrite `applySyncAdjust` to emit `nudge_rate` for nudge mode; update `mapCommandKind` to drop the `sync_adjust → seek` mapping.
- [extension/src/adapters/_template/index.ts](../../../extension/src/adapters/_template/index.ts) — implement `setPlaybackRate`; remove the `sync_adjust` switch arm.
- [extension/src/adapters/miruro/index.ts](../../../extension/src/adapters/miruro/index.ts) — same change; preserve the existing `<video>` cleanup pattern.
- [extension/docs/protocol-client.md](../../../extension/docs/protocol-client.md) — update the drift-handling table and remove the "deliberately not implemented yet" entry for rate nudging.
- [extension/docs/adapter-contract.md](../../../extension/docs/adapter-contract.md) — document the new `setPlaybackRate` method.
- [EXTENSION_TODO.md](../../../EXTENSION_TODO.md) — move the bullet out of Cleanup/quality once shipped.

## Tasks

### Task 1: Save spec documentation

This folder: `plan.md`, `shape.md`, `references.md`, `standards.md`.

### Task 2: Extend the Adapter contract

In `extension/src/adapters/types.ts`:

- Add `setPlaybackRate(rate: number): void` to the `Adapter` interface, between `getState()` and `destroy()`. JSDoc explains: declarative primitive; runtime drives the timing; adapter just writes through to the underlying player. `rate === 1` is the restore call.
- Replace the `sync_adjust` variant in `AuthoritativeCommand` with `{ type: 'nudge_rate'; targetPos: number }`. Update the union JSDoc to describe `nudge_rate` and drop the `delta` mention.

### Task 3: Update both adapters

In `extension/src/adapters/_template/index.ts` and `extension/src/adapters/miruro/index.ts`:

- Implement `setPlaybackRate(rate)`: `if (this.video) this.video.playbackRate = rate`.
- Remove the `sync_adjust` arm from `ctx.onCommand`. Add a `nudge_rate` arm that's a no-op — the runtime intercepts this command before it reaches the adapter (see Task 4), but the type system still requires the case to be exhaustively handled.
- No `destroy()` change needed in the adapters themselves; the runtime restores rate to 1 before adapter teardown.

### Task 4: Runtime nudge orchestration

In `extension/src/adapters/runtime.ts`:

- Add module-level state: `nudgeTimer: ReturnType<typeof setTimeout> | null`.
- In `deliverCommand`, before calling `state.commandHandler?.(cmd)`:
  - If `cmd.type === 'nudge_rate'`: handle it locally; do NOT forward to the adapter handler. Steps:
    1. Cancel any in-flight nudge timer; call `adapter.setPlaybackRate(1)` first to restore baseline.
    2. Read `currentPos = adapter.getState()?.currentPos`. If `null`, log a warn and bail (no state to nudge from).
    3. `delta = cmd.targetPos - currentPos`. If `|delta| < 50ms` worth (0.05 s), bail — already inside the dead band.
    4. `rate = delta > 0 ? 1.05 : 0.95`.
    5. `durationMs = Math.min(Math.abs(delta) / 0.05 * 1000, 3000)`.
    6. `adapter.setPlaybackRate(rate)`; schedule `nudgeTimer = setTimeout(() => { adapter.setPlaybackRate(1); nudgeTimer = null }, durationMs)`.
  - If `cmd.type === 'seek'` or `cmd.type === 'play'` or `cmd.type === 'pause'` and a nudge is in flight: cancel the timer and restore rate to 1 first, then forward the command. (A seek mid-nudge would otherwise leave rate clamped.)
- In `teardown()`, before `state.adapter.destroy()`: if `nudgeTimer` is set, clear it and call `state.adapter.setPlaybackRate(1)` best-effort inside a try/catch. Null out `nudgeTimer`.

### Task 5: Session folder

In `extension/src/background/session.ts`:

- Rewrite `applySyncAdjust`:
  ```ts
  if (frame.mode === 'seek') {
    return [{ type: 'seek', time: frame.targetPos }]
  }
  return [{ type: 'nudge_rate', targetPos: frame.targetPos }]
  ```
- In `mapCommandKind`, drop the `case 'sync_adjust'` and add `case 'nudge_rate': return null` — playbackRate changes don't echo via any listener we install, so no suppression slot is armed.

### Task 6: Docs

- `extension/docs/protocol-client.md` — update the drift-handling table: `nudge-rate` row becomes "clamp `<video>.playbackRate` to ±5% for up to 3 s; runtime drives the timer." Drop the corresponding entry from "What's deliberately not implemented yet."
- `extension/docs/adapter-contract.md` — add `setPlaybackRate(rate: number)` to the contract section.
- `EXTENSION_TODO.md` — remove the "Real `nudge-rate` for `SYNC_ADJUST`" bullet from Cleanup/quality.

## Verification

1. **Build:** `cd extension && pnpm dev` (or whatever the project's dev command is — check `extension/package.json`). Confirm no TS errors after the contract/union changes.
2. **Type exhaustiveness:** TS should flag the removed `sync_adjust` case in any switch that didn't get updated. Compiler is the watchdog here.
3. **Manual nudge test on miruro:**
   - Load the extension into a Chromium profile with a synced room set up via the share URL flow.
   - Join the room from a second client (second browser or incognito).
   - Manually pause one client for ~300 ms then resume to introduce sub-500 ms drift.
   - Observe via DevTools the `ratechange` event on `#player-container .player video`, and that `playbackRate` returns to `1` within ≤3 s.
   - Confirm no hard `seeking` event fires in the nudge case.
4. **Manual seek-fallback test:** Pause one client for >500 ms; verify a `seek` command still hard-seeks (existing path unchanged).
5. **Suppression sanity:** Confirm the `ratechange` does NOT cause a feedback `EVENT` to the daemon (check WS frames in DevTools network tab). It shouldn't, since no adapter listens to `ratechange`.
6. **Teardown sanity:** Navigate away mid-nudge; confirm no console errors and the timer is cancelled.
