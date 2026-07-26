# Code Review — `7a10f96`

> `fix(extension): fatal missing-video + restore strm.cx cold-start activation`
> Reviewed: `7a10f966c5085597e23c0db2c5e0ea19ed1420ad`

Typecheck (`npm run compile`) and lint (`npm run lint`) both pass. Findings are
ranked by how confident I am that each is worth acting on.

---

## 1. `ensurePlayable` self-load short-circuit has a gap — likely drives Space on self-loading providers

**Confidence: medium-high · Severity: medium**

In [`extension/src/adapters/strmcx/index.ts:119-160`](extension/src/adapters/strmcx/index.ts#L119-L160),
the "don't touch self-loaders" protection rests on two mechanisms, and both can
fail together for exactly the common case:

- The `loadstart` short-circuit lives inside
  [`waitForPlayButton`](extension/src/adapters/strmcx/index.ts#L175-L187), but it
  only helps while `waitForElement` is *waiting*. `waitForElement` does a
  synchronous `querySelector` first
  ([`video-driver.ts:83`](extension/src/adapters/video-driver.ts#L83)) and
  resolves immediately if the element is already present. Vidstack renders
  `<media-play-button>` as part of the same player chrome that owns the
  `<video>` — so by the time `resolveVideo()` has found the `<video>` and we
  reach `ensurePlayable`, the button is almost certainly already in the DOM.
  `waitForElement` returns it synchronously and `loadstart` never gets a chance
  to abort anything.
- `currentSrc` is then checked exactly once, at
  [line 125](extension/src/adapters/strmcx/index.ts#L125) — *before* the
  `PLAY_BUTTON_SETTLE_MS` (300 ms) + `KEY_RELEASE_DELAY_MS` waits. A self-loader
  that populates `currentSrc` during that ~330 ms window is never re-checked, so
  the synthesized Space keydown/keyup at
  [lines 148-153](extension/src/adapters/strmcx/index.ts#L148-L153) fires anyway.

This is reachable for self-loaders at all only because `resolveVideo()` waits for
the `<video>` *element*, not its source — so a video that self-loads "~1 s" later
is sourceless at the `canPlay()` check in
[`base.ts:119`](extension/src/adapters/media/base.ts#L119) and does enter
`ensurePlayable`. That contradicts the claim in `adapter-miruro.md` that
self-loaders are short-circuited by `canPlay`; in practice they seem to fall into
this path and rely on a short-circuit that doesn't engage.

The impact is probably masked (final `video.pause()` + the autoplay hold likely
settle it paused before the room command), but it's an unintended keypress +
delay on a path the author believed was skipped, and driving a play-toggle on an
already-playing/loading player is a real flash/glitch risk.

**Suggested fix:** re-check `if (video.currentSrc) return` after the settle delay
(and ideally right before dispatching), not only before it.

---

## 2. `isViewerDriven()` can misclassify an auto-play as viewer-driven for several seconds

**Confidence: medium · Severity: medium**

[`base.ts:304-307`](extension/src/adapters/media/base.ts#L304-L307) uses
`navigator.userActivation.isActive`. The comment (and
[`base.ts:294-300`](extension/src/adapters/media/base.ts#L294-L300)) describes
this as "true only while a real user gesture is driving the turn" — but
`isActive` reflects *transient activation*, which persists for the activation
lifetime (~5 s in Chrome) after **any** user gesture, not just while a handler
runs.

So if the viewer clicks anything post-load (dismiss an overlay, fullscreen, click
the video area) and the player's buffered auto-play fires within that window,
`isViewerDriven()` returns `true`, the hold is released
([`base.ts:270-273`](extension/src/adapters/media/base.ts#L270-L273)), and the
auto-play propagates to the room as a `play` intent — forcing a paused room to
play. That's precisely the failure this commit set out to prevent. It requires a
coincidental recent gesture, so it won't bite often, but the guarantee is weaker
than the doc states.

---

## 3. Fatal media-fail vs. `media_hello` ordering race can tear down a working room

**Confidence: medium-low · Severity: medium**

The phantom-sibling exception in
[`background.ts:549-564`](extension/entrypoints/background.ts#L549-L564) only
stays "soft" when `owner` is already set. But `owner` is set from
`media_hello`/`intent`/`status`, and `media_hello` is sent only after the working
frame's **entire** `init` completes — including `ensurePlayable`, which can run
up to ~10 s in the worst case (5 s button wait + 0.3 s + 5 s load wait) — see
[`runtime.ts:203`](extension/src/adapters/media/runtime.ts#L203). A videoless
sibling, meanwhile, fails at a fixed `VIDEO_WAIT_TIMEOUT_MS = 10 s`.

So a slow-initializing working frame (notably the new button-loader case) racing
a videoless sibling can have the sibling's fail land while `owner` is still
`undefined` → the `owner === undefined` branch falls through to the fatal
teardown, killing a room that would have worked. The happy path (fast init) is
fine; this is an edge, but the exception's correctness hinges on an ordering that
this same commit makes slower.

---

## 4. Broken `@link userInitiatedPlay` JSDoc references

**Confidence: high · Severity: low**

Three doc references point to a method that doesn't exist — the method is
`isViewerDriven`:

- [`base.ts:15`](extension/src/adapters/media/base.ts#L15)
- [`base.ts:80`](extension/src/adapters/media/base.ts#L80)
- [`base.ts:253`](extension/src/adapters/media/base.ts#L253)

Looks like a rename that missed the comments. Given `CLAUDE.md`'s emphasis on
real, accurate JSDoc, worth a trivial fix.

---

## 5. Minor: benign phantom-sibling failures log at `error` in the frame

**Confidence: high · Severity: low (cosmetic)**

[`runtime.ts:227-236`](extension/src/adapters/media/runtime.ts#L227-L236) always
logs `error` on fail, even when the background will treat it as an ignorable
non-owner phantom
([`background.ts:551`](extension/entrypoints/background.ts#L551)). The comment
acknowledges this ("reports loudly … lets the background decide"), so it's
intentional — but if phantom/preload embeds are common on miruro, every load
prints a red console error for an expected condition. Flagging only as
console-noise.

---

## Things I checked that are fine

- The hold/intent-suppression ordering is correct: `installAutoplayHold` wires
  its `play` listener before `wireIntentListeners`, so a re-pause runs before the
  intent sampler, and a released hold lets the viewer's intent through
  ([`base.ts:117-139`](extension/src/adapters/media/base.ts#L117-L139)).
- `waitForElement` resolves `null` (never rejects) on abort/timeout, so the
  `loadstart` short-circuit and `ensurePlayable` can't throw into `init`.
- Dropping `releaseAutoplayHold()` from the `pause` case is consistent with the
  10 s safety timer, so the viewer is never permanently stuck.
- The synthesized `keyCode`/`which` in the `KeyboardEventInit` are non-functional
  per spec, but Vidstack activates on `key`/`code` (`' '`/`'Space'`), which are
  set — and it was verified live, so not a concern.
- `clearMediaFrame` is not orphaned (still used at
  [`background.ts:1223`](extension/entrypoints/background.ts#L1223)).

---

## Recommendation

Highest-value fix is **#1** (add the post-settle `currentSrc` re-check) — it's a
concrete code change and the most likely to produce a user-visible glitch. **#2**
and **#3** are genuine but edge-conditional; **#4** is a quick doc cleanup.
