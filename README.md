# vis

A desk-side eye app for someone with high myopia who works at a laptop all day.
It nags 20-20-20 breaks, logs a one-line symptom check-in, keeps a streak that
only counts the days you're actually at the desk, times outdoor minutes on the
phone, and charts your prescription against the noise in how it's measured. It
also tells you, with citations, that none of this lowers the number. Everything
is stored in your browser; an optional sync copies records to a Turso database
you own. No account, no backend, no analytics.

## How to run it

**Use the hosted copy.** Open https://talon270.github.io/vis/ in Chrome and click
Install (the icon at the right of the address bar). After one visit it opens with
no network at all.

**Or open it from disk.** `index.html` runs from `file://` with nothing to
install. Chrome won't show system notifications or run the service worker for a
file, so reminders appear inside the window instead, and the app says so in
Settings.

**Start it at login (Linux).** Install it from Chrome first. Chrome writes a
launcher for an installed app to
`~/.local/share/applications/chrome-<app-id>-Default.desktop`; copy that file into
`~/.config/autostart/`. That path is Chrome's convention on Linux, and it hasn't
been checked against this app yet.

**Run the self-check.**

```sh
node tools/check-logic.js
```

It runs the date keys, streak, merge, sync SQL, backup and CSV logic against
`logic.js` with plain `assert`. It prints one line when everything passes.

**Turn on sync (optional).** Create a Turso database and a token for it:

```sh
turso db show <db> --url
turso db tokens create <db>
```

Paste both into Settings → Sync, click **Test connection**, then tick **Sync this
device**. The tick stays off until a test passes, and editing either field turns
it off again.

## What's in it

| View | What it does |
|---|---|
| **Today** | Break count, "Look away for 20 s" (the break logs itself at 0), the day's check-in (dryness, headache, blur, 0–3), the streak with a two-week calendar, and — after 14 check-ins — symptoms on high-break days against low-break days |
| **Exercises** | Nine guided exercises (palming, blinking, near-far focus, figure-eight, eye rolls, saccade jumps, and three with a tennis ball: tracking, push-ups, toss and catch), each tagged with how much evidence there is for it, and a citation |
| **Outdoor** | A start/stop timer and a +15 min quick-add, against a 2 h reference. Timed and estimated minutes are kept apart |
| **Rx** | One entry per exam: sphere, cylinder and axis per eye. Spherical equivalent chart with a ±0.50 D band, the next dilated exam, and the warning signs that need care right away |
| **Facts** | What can and can't change a prescription, when myopia counts as high, screen setup, blue-light lenses — each claim cited, each card saying whether it read the abstract or the full text |
| **Settings** | Theme, day rollover (up to 06:00), reminder days and quiet hours, check-in nudge, backup/restore, CSV export, sync |

| Setting | Default | Why |
|---|---|---|
| Break reminders | Off | Each device decides. The phone has no break reminders |
| Reminder days | Mon–Fri | These are also the desk days the streak counts |
| Quiet hours | 22:00–07:00 | |
| Check-in nudge | Off, 21:00 when on | Settings don't sync, so the phone never nags at night unless you ask it to |

## The things most eye apps get wrong

**It never claims to lower your prescription.** No home method has been shown
to. The American Academy of Ophthalmology says "there is no scientific evidence
to suggest that eye exercises, vitamins or pills can prevent or cure myopia". The
one meta-analysis that seems to favour exercise (Lin et al., *Eye* 2024, 11
trials) pools a risk ratio of 0.40 (95% CI 0.23–0.71). But three of its seven
studies counted eyes instead of people, without allowing for two eyes belonging
to one person. Without them it is 0.53 (95% CI 0.18–1.59, P = 0.26), no longer
significant, and the authors conclude "limited to no efficacy". What does work —
atropine and myopia-control lenses — **slows** myopia, it doesn't reverse it, and
the evidence is from children: a 2025 Cochrane review of 104 trials, 17,509
children aged 4 to 18. So every exercise carries a tag ("No evidence", "Weak
evidence: dry eye"), and the Facts card's right-hand column says "Slows it, in
children", not "can lower".

**Weekends are not misses.** A desk day is done with 6 breaks (two hours of
20-minute cycles actually taken) plus a check-in. Breaks only happen at the
laptop, so a Saturday scores 0 breaks. Counted as a miss, that would spend the
one forgiven miss a month on the first weekend, and the streak would reset
almost every week after — the app arguing with your actual routine. Only the
days ticked as reminder days count. The rest show as "not a desk day", neither
done nor missed. Changing the ticked days re-scores past days too, and Settings
says so where you tick them.

**A change under 0.50 D is shaded as possible noise.** Two refractions of the
same eye don't agree exactly. The one study opened (Otero, *J Optom* 2019,
abstract) gives a within-subject SD of 0.13 D for spherical equivalent, two
sessions within a week. That is about ±0.36 D at 95% (2.77 × 0.13 — the app's
arithmetic, not the paper's). Exams at different clinics probably vary more, and
no figure for that was verified, so the band is rounded up to ±0.50 D and the
chart says the band is assumed. Going from −3.25 to −3.50 is a −0.25 D change:
inside the band, and the summary says it may be noise. Only exams marked
"dilated" reset the exam reminder; a glasses check without drops never silences
it. The 12-month interval is the app's choice — the AOA says yearly for adults,
the AAO every 5–10 years under 40 without risk factors — and the Rx view cites
both.

**A new device pulls before it pushes.** An earlier app of mine once synced a
fresh, empty device over a cloud copy holding 30 days of history and left it at
zero. So every sync here pulls and merges before it sends anything. The merge
only adds records or swaps in a newer copy of one: it can never write less over
more. A delete is a tombstone that syncs like an edit, and when a delete and an
edit carry the same timestamp, the delete wins on both sides, so two devices
can't settle on different answers. An empty device pulls everything and pushes
nothing.

**The pull cursor is the server's order, not the record's time.** A cursor on
`updatedAt` loses data silently. The phone logs a walk offline at 10:00. The
laptop syncs at 12:00, and its cursor moves past 10:00. The phone comes online
at 14:00 and pushes the walk — stamped 10:00. A laptop pulling `updatedAt >
12:00` never sees it, and nothing errors. Each row gets a server sequence number
when it is written instead, and the pull asks for `seq > last seen`. A push also
resends anything edited in the 10 minutes before the last good push, so a clock
correction can't strand an edit. Resending is harmless: an older copy loses the
upsert.

## What's solid and what's assumed

| Thing | Solid | Assumed |
|---|---|---|
| Breaks | Counted from clicks, exact | — |
| 6 breaks for a done day | — | The app's choice: two hours of cycles |
| 20-20-20 itself | It's widely given advice | That it relieves strain. The one controlled test found (Johnson & Rosenfield, *Optom Vis Sci* 2023, abstract) gave 30 young adults a 40-minute reading task with 20 s breaks every 5, 10, 20 or 40 minutes: no effect on symptoms (P = .70) |
| Outdoor minutes | The timer's start and stop | That you pressed them at the right time. Every +15 is your estimate and is marked as one |
| 2 h outdoors | China's 2018 plan for children; a 3-year school trial (He et al., *JAMA* 2015): 30.4% of first-graders not myopic at the start became myopic, against 39.5% | That it helps an adult. For eyes already myopic, Xiong 2017 found no effect and Cochrane 2024 is uncertain |
| Noise band | ±0.36 D for two refractions within a week, one study | ±0.50 D, rounded up to cover different clinics |
| Exam interval | AOA yearly; AAO 5–10 years under 40 without risk factors | 12 months, the app's pick between them |
| Symptoms vs breaks | Both means and both counts, per symptom | Anything causal. Same-day pairing only; hidden below 14 check-ins; a side needs 3 days before its mean shows (the app's floor) |
| Exercise tags | Each one cited, quotes matched word for word against the source | — |
| Sync from GitHub Pages to hosted Turso | Works against a local libSQL server, which allows any origin | That hosted Turso allows calls from this origin (CORS). Known only on your first Test connection, which says "CORS" if it doesn't |

## Data and privacy

- **Everything lives in your browser,** under one `localStorage` key, `vis.v1`,
  with a schema version and a migration path. Clearing site data deletes it.
  Download a backup first.
- **Backup is JSON with every record and your settings.** It leaves out the sync
  token and a running outdoor timer. Restore merges into what's there: it adds
  records or swaps in newer copies, and it can't delete anything. Settings are
  restored only if you tick the box, and never the reminder or nudge switches.
- **CSV export** gives one file each for breaks, outdoor time, symptoms and Rx.
  Removed entries are left out, and +15 entries say `estimate = yes`.
- **Sync sends only records.** Settings, a running timer and the token never
  leave the device. Each pushed row carries a random device id, which tells
  devices apart and holds nothing about you.
- **The token sits unencrypted in this browser profile.** Anyone who can open the
  profile can read it. Revoke it with `turso db tokens invalidate <db>`. That
  revokes **every** token for the database's group, not just this one. The
  commands above were checked against docs.turso.tech on 2026-10-14; the
  dashboard steps were not found in the docs.
- **Reminders only fire while the window is open.** The web has no API for a
  notification scheduled in advance, so a quit window means no reminders until
  you open it again. Today shows "Running since HH:MM", so a restart is visible.
- **No third-party scripts, fonts or requests.** IBM Plex Mono is in `fonts/`
  (SIL Open Font License, `fonts/OFL-ibmplexmono.txt`). The icons are Lucide (ISC;
  the ones derived from Feather are MIT), inlined, with the notices in
  `LICENSE-lucide.txt`.
- **Deploy** is GitHub Pages from `main`. The service worker is network-first
  with the cache as fallback, so an edited `index.html` and `logic.js` always
  arrive together. Bump `CACHE` in `service-worker.js` whenever the file list
  changes.
