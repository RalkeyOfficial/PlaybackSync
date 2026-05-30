# PlaybackSync — Modes UX in plain terms

## The two modes

**Default ("we're watching a series")**
The room has a planned list of videos. Everyone watches them together. Late arrivals get pulled to whatever the room is currently on.

**Freeform ("movie night")**
No plan. Whoever's actively picking right now is the DJ. Everyone follows the DJ's tab. When someone else picks something, *they* become the DJ.

---

## What happens when…

### You join a room

| Mode | You're on the right video | You're on a stale/different tab |
|---|---|---|
| Default | Stay put. | Your tab gets navigated to the room's current video. |
| Freeform | Stay put. | Your tab gets navigated to the room's current video. *(Joining never drags the room.)* |

Same behavior in both modes. Joining is passive — you sync up to the room, not the other way around.

### Someone already in the room navigates to a different video

| Mode | What happens |
|---|---|
| Default | Only works if that video is already on the planned list. Otherwise their navigation is rejected and their tab gets pulled back. |
| Freeform | Their navigation becomes the room. Everyone else's tab follows. The video gets logged into the playlist as "watched." |

This is the only real behavioral difference between the modes.

### Default mode off-list navigation: pull back, don't disconnect

When someone in a default-mode room navigates to a video that isn't on the planned list, their tab gets pulled back to the room's current video. They are **not** disconnected.

**Why pull back instead of disconnect:**
- Default mode's identity is "the room is anchored to a plan." Anchored rooms pull strays back; they don't eject.
- Misclicks on related-video thumbnails are the most common navigation event on YouTube/anime sites. Disconnecting on a misclick would force a rejoin every time and create constant friction.
- Pull back projects clear authority — the room has a plan, the plan is the truth.

**How to leave on purpose:**
Use the **"Leave room"** button in the extension popup. Navigation is never how you leave a room — only the explicit button is.

One-line: *"You can't leave by accident — only on purpose."*

---

## How videos get added to the playlist

Same rules in both modes:

- **Owner** adds them deliberately from the dashboard.
- **Extension** scrapes them automatically *only* when the page is a real catalog (anime episode list, YouTube playlist sidebar). Random pages contribute nothing.
- **Freeform only**: when an in-room person navigates somewhere new, that video gets added as a side-effect.

Regular viewers can't manually add videos. Period.

---

## One-line mental model

> **Default = the playlist drives the cursor. Freeform = the active person drives the cursor.**
> In both modes, joining never drives anything.
