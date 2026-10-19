# vis — suggestions

Written 2026-10-19, against `index.html` and `logic.js` at commit `1af9bfb`
(working tree clean before this pass).
Method: line-level read of all of `logic.js` and of the page script's storage,
sync, reminder scheduler, streak and boot sections. Headless Chromium runs on
`file://` and `http://`, light and dark, at 390, 1440 and 1920 px, with a
click-through of every nav item and button. A seeded 60-day profile (about 300
breaks, 38 check-ins, 6 outdoor entries, 3 Rx exams) through all six views in
both themes. Two windows sharing one profile, driven on a fake clock.

**One bug fixed in this pass (A1). Everything else below is a suggestion and is
not implemented.**

## Result

Zero page errors, console errors and failed requests in every run. No sideways
scroll at 390 px. At 1920 px the content sits centred beside the sidebar. The
seeded profile gives a streak of 3 with one forgiven miss, which is right for
that data. The symptoms-against-breaks card appears, and the Rx summary
arithmetic checks out (−3.75 → −4.38 SE is a −0.63 D change, outside the band).

## Part A — findings, ranked

### A1 · BUG (low): a break taken in one window doesn't restart the other window's cycle — FIXED

With the installed app and a browser tab open together, each window keeps its
own `startedAt`/`nextAt` in memory. The `storage` handler adopted the other
window's records but left this window's schedule alone. So the second window
reminded you on its old schedule, minutes after you had just taken a break.

Reproduced on a fake clock, two pages, one profile, reminders on. Window A
takes a 20 s break at 10:10:21.

| | Window A's next reminder | Window B's next reminder |
|---|---|---|
| Before | 10:30:21 | **10:20:00**, 10 min after the break |
| After | 10:30:22 | 10:30:22 |

**Fix (applied):** in the `storage` handler, find the newest live break. If
20 minutes after it is later than this window's `nextAt`, move `nextAt` there,
clear any snooze and drop the reminder on screen. That is 10 lines, all in the
one place where the other window's saves already arrive. Backup:
`index.backup-20261019-040451.html`. A single window still fires at 10:30:21.
The smoke and seeded runs are unchanged at 0 errors.

### A2 · DESIGN RISK (low): two windows still give two reminders per cycle

After A1 both windows fire at the same moment (10:30:22 above). An OS
notification uses the shared `vis-break` tag, so the second one replaces the
first. The in-window fallback (`file://`, or notifications blocked) gives one
toast per window. You only see the one in the window in front, so in practice
this is mostly noise. Your own `ponytail:` comment already names the fix:
**elect one window over `BroadcastChannel`**. Only worth it if double beeps
actually bother you; with sound on, both windows beep.

## Part B — improvements (suggested, not implemented)

None that clear the bar. The plan's own "Not done" lists already cover the
real gaps: logging outdoor time for a past day, a weekly view, a backup
reminder, and a phone-rotation redraw. Two things need a real device or a
hosted database, not code:

- **Hosted Turso CORS** is still unconfirmed (README "assumed" table). The
  first Test connection settles it.
- **Phone behaviour** (bottom bar at 12 px, the ball exercises' beep spacing)
  is still unseen on a phone.

## Out of scope

- `logic.js` — read in full and not changed. `tools/check-logic.js` result is
  in the run log below.
- Copy and citations on the Facts, Rx and Exercises cards — not re-checked
  against their sources. They carry their own verification dates.

## Check log

- `node tools/check-logic.js`: all asserts pass (test-runner agent; A1
  touched only `index.html`, not `logic.js`).
