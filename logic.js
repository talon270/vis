/* ============================================================================
   VIS · LOGIC
   ----------------------------------------------------------------------------
   Pure functions only: no DOM, no storage, no clock unless one is passed in.
   That is what lets node test them (tools/check-logic.js) with the same file
   the page loads.

     · SCHEMA       SCHEMA_VERSION, defaultState(), migrate()
     · DATE KEYS    local-time YYYY-MM-DD, with a day rollover up to 06:00
                    (never UTC: India is +05:30, so a UTC key files everything
                    before 05:30 on the wrong day)
     · THEME        themeId() — the saved preference to a palette id
     · BREAKS       the 20-20-20 schedule (weekday mask, quiet hours, a gap
                    that means the laptop slept) and the daily break count
     · EXERCISES    the day's finished guided exercises, by id
     · OUTDOOR      a start/stop timer that survives a reload, +15 min estimates,
                    and a forgotten-stop guard; timed and estimated time kept apart
     · CHECK-IN     one symptom record per day, all three scores or nothing,
                    and when the evening nudge is due
     · STREAK       done desk days in a row, with Helth's monthly grace; days
                    that aren't desk days neither count nor break it (A1)
     · COMPARE      mean symptom scores on desk days with many breaks against
                    few, once there are enough check-ins to say anything
     · RX           one record per exam date, both eyes, checked to 0.25 D;
                    spherical equivalent, the change between exams against
                    the noise band, and when the next dilated exam is due
     · EXPORT       the JSON backup (records and settings, never the token), its
                    parse and merge-restore, and one CSV per kind of record
     · SYNC         the Turso table's SQL, record ↔ row, Hrana value encoding,
                    the merge (union by id, newest wins, tombstones, never
                    shrinks) and which records a push sends

   Public: window.Vis.logic in the browser, module.exports in node.
   ========================================================================== */
(function (root) {
  "use strict";

  /* Bump this and write the upgrade step in migrate() in the same change. */
  var SCHEMA_VERSION = 1;

  /* Rollover is capped at 06:00. Later than that, a morning session would land
     on the previous day, which is the mis-filing this setting exists to stop. */
  var MAX_DAY_START_HOUR = 6;

  var THEMES = { system: 1, dark: 1, light: 1 };

  /* The rule is 20-20-20, so these are not settings. */
  var BREAK_INTERVAL_MIN = 20;
  var LOOK_SECONDS = 20;
  /* Short, because the whole cycle is 20 minutes. A 15-minute snooze would
     nearly skip a break. */
  var SNOOZE_MIN = 5;
  /* A reminder this late means the tick wasn't running: the laptop slept or
     the window was frozen. Firing then would nag the moment you sit back
     down, after time away from the screen. The gap must exceed the one-minute
     timer throttling Chrome applies to a hidden window, or a minimised window
     would never fire. */
  var SLEPT_AFTER_MS = 5 * 60000;

  /* Each scored 0 (none) to 3 (severe). The form is built from this list. */
  var SYMPTOMS = ["dryness", "headache", "blur"];
  var SCORE_MAX = 3;

  /* A desk day is done with this many breaks plus a check-in. Six breaks is
     two hours of 20-minute cycles actually taken. */
  var DONE_BREAKS = 6;
  /* Missed desk days a streak may walk over, per calendar month of the miss.
     Helth's default. Not a setting: the desk-day rule already removes the
     weekend misses that a monthly allowance couldn't cover (A1). */
  var GRACE_PER_MONTH = 1;

  /* Outdoor time. 2 h a day is the figure used in trials in children, so the
     UI labels it a reference and not a prescription for an adult. */
  var OUTDOOR_TARGET_MIN = 120;
  var QUICK_ADD_MIN = 15;
  /* A timer left running past this is a forgotten stop, not a long walk.
     Four hours is longer than almost any real outing, and short enough that
     an overnight run is always caught. Over it, the minutes are asked for
     instead of logged, so a forgotten timer never writes a 9-hour day. */
  var MAX_RUN_MS = 4 * 3600000;
  /* Under a minute is a mis-tap, not time outside. */
  var MIN_RUN_SEC = 60;

  /* Rx. Prescriptions are written in quarter dioptres. The ranges are wide
     enough for any real slip and narrow enough to catch a dropped decimal
     point (-325 for -3.25). */
  var RX_STEP = 0.25;
  var RX_SPH_MIN = -30, RX_SPH_MAX = 25, RX_CYL_MAX = 10;
  /* A change in SE this small may be measurement noise. This is an assumption.
     The one study checked (Otero 2019, same eyes refracted twice within a
     week) gives about ±0.36 D, and exams at different clinics vary more, so
     0.5 is rounded up. The Rx view says so. */
  var RX_NOISE_D = 0.5;
  /* Months from the last dilated exam to the next one. This is the app's
     choice, not a settled rule: the AOA says yearly for adults and the AAO
     says every 5–10 years under 40. The Rx view cites both. */
  var EXAM_INTERVAL_MONTHS = 12;
  var EYES = ["od", "os"];   // right, left: the order every Rx slip uses

  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      settings: {
        theme: "system",   // "system" | "dark" | "light"
        dayStartHour: 0,   // 0–6; logs before this hour count toward the day before
        breaks: {
          /* Off until you turn it on. The phone is a companion with no break
             reminders, and settings never sync, so each device decides. */
          enabled: false,
          days: [1, 2, 3, 4, 5],   // 0 = Sunday. Also the desk days the streak counts (A1)
          quiet: { enabled: true, from: "22:00", to: "07:00" },
          sound: true
        },
        checkin: {
          /* Off until you turn it on, for the same reason as break reminders:
             settings don't sync, and the phone shouldn't nag at 21:00. */
          nudge: false,
          time: "21:00"
        }
      },
      /* Logged events, in the shape B10 syncs: { id, kind, day, at, updatedAt },
         plus deletedAt once something can be deleted.
         ponytail: one array in one localStorage key, about 70 bytes a break.
         At 30 breaks a day that is ~0.8 MB a year against a ~5 MB quota, so
         roughly six years. Move records to IndexedDB before then. */
      records: [],
      /* Start time (ms) of a running outdoor timer, or null. Kept in storage so
         a reload mid-walk doesn't lose the walk, and outside `records` so it
         is local-only until stopped: B10 must not sync it. */
      outdoorRun: null,
      /* Sync (B10). Local-only, every field: only `records` ever leave this
         device. The token is here, so the B11 backup must leave this out. */
      sync: {
        url: "",
        token: "",
        tested: false,     // this url + token passed Test connection
        on: false,         // can only be true while tested is
        deviceId: null,    // set by the app on first load; written to each row it pushes
        pullSeq: 0,        // highest server seq merged here: the pull cursor
        pushMark: 0,       // local clock when the last good push was snapshotted
        lastOkAt: null,
        lastError: null    // "401" | "offline" | "cors" | "http 404" | "sql" …
      }
    };
  }

  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function isHhmm(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }

  /* Saved state of any age in, current shape out. Never throws, never drops a
     field it doesn't recognise. */
  function migrate(raw) {
    var s = defaultState();
    if (!isObj(raw)) return s;
    var from = Number(raw.version) || 0;

    /* Saved values over defaults: a field added in a later build gets its
       default, and a field this build doesn't know survives the next save. */
    Object.keys(raw).forEach(function (k) { s[k] = raw[k]; });
    var rs = isObj(raw.settings) ? raw.settings : {};
    s.settings = Object.assign(defaultState().settings, rs);
    /* Nested objects merge one level down too, so a save missing one break
       field keeps the others and gets the default for that one. */
    var b = s.settings.breaks = Object.assign(defaultState().settings.breaks, isObj(rs.breaks) ? rs.breaks : {});
    b.quiet = Object.assign(defaultState().settings.breaks.quiet, isObj(b.quiet) ? b.quiet : {});
    var c = s.settings.checkin = Object.assign(defaultState().settings.checkin, isObj(rs.checkin) ? rs.checkin : {});

    /* Upgrade steps go here, oldest first, each guarded by the version it
       upgrades from:
         if (from < 2) { ...v1 → v2... }
       None exist yet: v1 is the first shape. */

    /* A save from a newer build keeps its number. Writing 1 over it would make
       that build re-run its upgrade steps on data that is already upgraded. */
    s.version = Math.max(from, SCHEMA_VERSION);

    if (!THEMES[s.settings.theme]) s.settings.theme = "system";
    b.enabled = b.enabled === true;
    b.sound = b.sound !== false;
    b.days = Array.isArray(b.days)
      ? b.days.filter(function (d, i, a) { return d === Math.floor(d) && d >= 0 && d <= 6 && a.indexOf(d) === i; }).sort(function (x, y) { return x - y; })
      : defaultState().settings.breaks.days;
    b.quiet.enabled = b.quiet.enabled !== false;
    if (!isHhmm(b.quiet.from)) b.quiet.from = "22:00";
    if (!isHhmm(b.quiet.to)) b.quiet.to = "07:00";
    c.nudge = c.nudge === true;
    if (!isHhmm(c.time)) c.time = "21:00";
    if (!Array.isArray(s.records)) s.records = [];
    if (!(Number.isFinite(s.outdoorRun) && s.outdoorRun > 0)) s.outdoorRun = null;
    /* Added in B10 without a SCHEMA_VERSION bump: a v1 save without it gets the
       defaults here, and no record changes shape (every record already carries
       updatedAt). A bad cursor or mark falls to 0, which re-pulls or re-pushes
       everything: slower, never lossy, because merge and upsert are idempotent. */
    var y = s.sync = Object.assign(defaultState().sync, isObj(raw.sync) ? raw.sync : {});
    if (typeof y.url !== "string") y.url = "";
    if (typeof y.token !== "string") y.token = "";
    y.tested = y.tested === true;
    y.on = y.on === true && y.tested;
    if (typeof y.deviceId !== "string" || !y.deviceId) y.deviceId = null;
    if (!(Number.isFinite(y.pullSeq) && y.pullSeq >= 0)) y.pullSeq = 0;
    if (!(Number.isFinite(y.pushMark) && y.pushMark >= 0)) y.pushMark = 0;
    if (!Number.isFinite(y.lastOkAt)) y.lastOkAt = null;
    if (typeof y.lastError !== "string") y.lastError = null;
    var h = Number(s.settings.dayStartHour);
    s.settings.dayStartHour = (h >= 0 && h <= MAX_DAY_START_HOUR) ? Math.floor(h) : 0;
    return s;
  }

  function ymd(d) {
    return d.getFullYear() + "-" +
           String(d.getMonth() + 1).padStart(2, "0") + "-" +
           String(d.getDate()).padStart(2, "0");
  }

  function parseYmd(key) {
    var p = String(key).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  /* n days after `key`; negative n goes back. */
  function addDays(key, n) {
    var d = parseYmd(key);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  /* The day a moment belongs to. With dayStartHour 4, 02:30 on the 11th is
     still the 10th — the session you started at 23:00 ends on the day it began. */
  function dayOf(t, dayStartHour) {
    var d = new Date(t);
    if (dayStartHour > 0 && d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
    return ymd(d);
  }

  /* "selene" is Helth's dark palette, "selene-day" its light one. */
  function themeId(pref, systemDark) {
    if (pref === "dark") return "selene";
    if (pref === "light") return "selene-day";
    return systemDark ? "selene" : "selene-day";
  }

  /* ---- BREAKS ------------------------------------------------------------- */
  function hhmmToMins(hhmm) {
    var p = String(hhmm).split(":");
    return Number(p[0]) * 60 + Number(p[1]);
  }

  /* Why no reminder may fire at this moment: "day" (not a ticked weekday),
     "quiet" (inside quiet hours) or null. A quiet window may wrap midnight,
     which is the usual case (22:00 → 07:00). */
  function breakBlocked(cfg, date) {
    if (cfg.days.indexOf(date.getDay()) < 0) return "day";
    var q = cfg.quiet;
    if (q.enabled) {
      var m = date.getHours() * 60 + date.getMinutes();
      var from = hhmmToMins(q.from), to = hhmmToMins(q.to);
      if (from < to ? (m >= from && m < to) : from > to && (m >= from || m < to)) return "quiet";
    }
    return null;
  }

  /* "wait" before nextAt, "fire" when due, "slept" when so overdue that the
     tick can't have been running (see SLEPT_AFTER_MS). */
  function breakDue(now, nextAt) {
    if (now < nextAt) return "wait";
    return now - nextAt > SLEPT_AFTER_MS ? "slept" : "fire";
  }

  function countBreaks(records, day) {
    return records.filter(function (r) { return r.kind === "break" && r.day === day && !r.deletedAt; }).length;
  }

  /* ---- EXERCISES ---------------------------------------------------------- */
  /* Finished runs of a guided exercise on `day`, by exercise id. An exercise is
     its own event kind and never a break: the streak's break count stays
     exactly the number of 20-second look-aways you took. */
  function countExercises(records, day) {
    var out = {};
    records.forEach(function (r) {
      if (r.kind === "exercise" && r.day === day && !r.deletedAt) out[r.exercise] = (out[r.exercise] || 0) + 1;
    });
    return out;
  }

  /* ---- OUTDOOR ------------------------------------------------------------ */
  /* Timed runs are measured; quick-adds are the user's estimate. Both are kept
     apart in the totals, because the app shows how much of the number it
     measured and how much it was told. */
  function outdoorDay(records, day) {
    var out = { timed: 0, quick: 0, entries: [] };
    records.forEach(function (r) {
      if (r.kind !== "outdoor" || r.day !== day || r.deletedAt) return;
      out[r.source === "quick" ? "quick" : "timed"] += r.seconds;
      out.entries.push(r);
    });
    out.entries.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  /* Start a timer. Returns false, changing nothing, if one is already running:
     a second tap must not move the start of a walk already under way. */
  function startRun(state, now) {
    if (state.outdoorRun) return false;
    state.outdoorRun = now;
    return true;
  }

  function runMs(state, now) { return state.outdoorRun ? Math.max(0, now - state.outdoorRun) : 0; }

  /* Over MAX_RUN_MS the UI must ask for the minutes instead of stopping. */
  function runNeedsReview(state, now) { return runMs(state, now) > MAX_RUN_MS; }

  /* Stop the timer and log it. `seconds` overrides the elapsed time and is the
     reviewed figure for a run over MAX_RUN_MS. The run belongs to the day it
     began, as with dayOf: a walk started at 23:30 ends on the day it began.
     Returns the record, or null if nothing was running or it was under
     MIN_RUN_SEC (the timer is cleared). A bad override returns null and
     keeps the timer: clearing it would lose the walk to a caller's typo. */
  function stopRun(state, now, id, dayStartHour, seconds) {
    if (!state.outdoorRun) return null;
    if (seconds != null && !(Number.isInteger(seconds) && seconds >= MIN_RUN_SEC)) return null;
    var start = state.outdoorRun;
    var secs = seconds == null ? Math.floor(runMs(state, now) / 1000) : seconds;
    state.outdoorRun = null;
    if (!Number.isInteger(secs) || secs < MIN_RUN_SEC) return null;
    var rec = { id: id, kind: "outdoor", source: "timed", day: dayOf(start, dayStartHour),
                seconds: secs, startedAt: start, at: now, updatedAt: now };
    state.records.push(rec);
    return rec;
  }

  function discardRun(state) { state.outdoorRun = null; }

  /* +15 min, marked "quick" so it is shown as an estimate. */
  function quickAdd(records, now, id, dayStartHour) {
    var rec = { id: id, kind: "outdoor", source: "quick", day: dayOf(now, dayStartHour),
                seconds: QUICK_ADD_MIN * 60, at: now, updatedAt: now };
    records.push(rec);
    return rec;
  }

  /* A delete is a tombstone, so it syncs like an edit and can't come back (A5). */
  function removeRecord(records, id, now) {
    var rec = records.filter(function (r) { return r.id === id && !r.deletedAt; })[0];
    if (!rec) return false;
    rec.deletedAt = rec.updatedAt = now;
    return true;
  }

  /* ---- CHECK-IN ----------------------------------------------------------- */
  /* One id per day, not per save. In B10 both devices' check-ins for a day
     then land on the same row and the newer one wins; a random id would keep
     two conflicting check-ins for one day. */
  function checkinId(day) { return "checkin-" + day; }

  function findCheckin(records, day) {
    var id = checkinId(day);
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === id && !records[i].deletedAt) return records[i];
    }
    return null;
  }

  /* Every symptom rated with a whole number 0–SCORE_MAX. A missing score is
     not a 0: a skipped symptom must stay blank, never guessed. */
  function validScores(s) {
    return isObj(s) && SYMPTOMS.every(function (k) {
      return Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= SCORE_MAX;
    });
  }

  /* Writes the day's check-in into `records` in place, over any earlier one
     for that day. Returns false and changes nothing if any score is missing
     or out of range. */
  function setCheckin(records, day, scores, now) {
    if (!validScores(scores)) return false;
    var clean = {};
    SYMPTOMS.forEach(function (k) { clean[k] = scores[k]; });
    var id = checkinId(day);
    var rec = records.filter(function (r) { return r.id === id; })[0];
    if (rec) {
      rec.scores = clean;
      rec.updatedAt = now;
      delete rec.deletedAt;   // saving again un-deletes, and the newer updatedAt carries that in sync
    } else {
      records.push({ id: id, kind: "checkin", day: day, scores: clean, updatedAt: now });
    }
    return true;
  }

  /* Has the app's day reached the nudge time? Both are measured from the
     rollover, so with a 04:00 rollover a 00:30 nudge belongs to the day that
     is ending, and 01:00 is still past a 21:00 nudge for that day. */
  function pastNudge(date, hhmm, dayStartHour) {
    var off = dayStartHour * 60;
    var m = date.getHours() * 60 + date.getMinutes();
    return (m - off + 1440) % 1440 >= (hhmmToMins(hhmm) - off + 1440) % 1440;
  }

  /* ---- STREAK ------------------------------------------------------------- */
  /* One pass over the records: day → { breaks, checkin }. The streak reads a
     day many times, and the UI repaints it every second, so per-day scans of
     every record would cost days × records each time. */
  function dayIndex(records) {
    var idx = {};
    records.forEach(function (r) {
      if (r.deletedAt || (r.kind !== "break" && r.kind !== "checkin")) return;
      var d = idx[r.day] || (idx[r.day] = { breaks: 0, checkin: false });
      if (r.kind === "break") d.breaks++;
      else d.checkin = true;
    });
    return idx;
  }

  /* "off" (not a desk day: neither done nor missed, A1), "done" or "miss".
     A busy Saturday is still "off" while Saturday is unticked. */
  function dayStatus(idx, day, deskDays) {
    if (deskDays.indexOf(parseYmd(day).getDay()) < 0) return "off";
    var d = idx[day];
    return d && d.breaks >= DONE_BREAKS && d.checkin ? "done" : "miss";
  }

  /* Done desk days in a row, ending today if today is done, otherwise at the
     last desk day before it: today isn't a miss until it is over. Days off
     are stepped over.
     Grace is Helth's rule (gamify.js currentStreakInfo): a miss is walked
     over while its month has grace left AND the desk day before it was done,
     so grace bridges a one-day gap but never opens a run. A forgiven day is
     not counted, so the number is only days actually done.
     Returns { current, graced: [forgiven day keys] }. */
  function streak(idx, today, deskDays) {
    var out = { current: 0, graced: [] };
    if (!deskDays.length) return out;   // nothing is a desk day, and prevDesk would never stop
    function st(day) { return dayStatus(idx, day, deskDays); }
    function prevDesk(day) {
      do day = addDays(day, -1); while (st(day) === "off");
      return day;
    }
    var used = {};
    var cursor = st(today) === "done" ? today : prevDesk(today);
    /* 4000 desk days is 15 years: a guard, never the real stop. The run
       always ends at a miss, and every desk day before the first log is one. */
    for (var guard = 0; guard < 4000; guard++) {
      if (st(cursor) === "done") out.current++;
      else {
        var m = cursor.slice(0, 7);
        if ((used[m] || 0) >= GRACE_PER_MONTH || st(prevDesk(cursor)) !== "done") break;
        used[m] = (used[m] || 0) + 1;
        out.graced.push(cursor);
      }
      cursor = prevDesk(cursor);
    }
    return out;
  }

  /* ---- COMPARE ------------------------------------------------------------ */
  /* Nothing is shown below this many check-ins: fewer, and one bad week sets
     the whole answer. */
  var COMPARE_MIN_CHECKINS = 14;
  /* Each side of the split needs this many days before its mean is shown. One
     or two days is an anecdote, and a split that leaves a side empty (every
     day had the same break count) has nothing to compare. */
  var COMPARE_MIN_GROUP = 3;

  function mean(xs) { return xs.reduce(function (a, b) { return a + b; }, 0) / xs.length; }

  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Mean symptom scores on desk days with breaks at or above your own median
     against desk days below it. `idx` is dayIndex(records), passed in because
     the page already has it. Only days with a check-in count, and a day with a
     check-in but no breaks counts as 0 breaks. Days that aren't desk days are
     left out, and counted in `offDesk`, because a Saturday's break count isn't
     comparable to a workday's.
     Returns { total, needed, ready, used, offDesk, median, ok, hi, lo }.
     hi and lo are { n, breaks, score, by: {symptom: mean} }; ok is false while
     either side has fewer than COMPARE_MIN_GROUP days. Same-day pairing only:
     this can't see a bad week that follows a skipped one. */
  function symptomCompare(records, idx, deskDays) {
    var total = 0, days = [], offDesk = 0;
    records.forEach(function (r) {
      if (r.kind !== "checkin" || r.deletedAt || !validScores(r.scores)) return;
      total++;
      if (deskDays.indexOf(parseYmd(r.day).getDay()) < 0) { offDesk++; return; }
      days.push({ breaks: idx[r.day] ? idx[r.day].breaks : 0, scores: r.scores });
    });
    var out = { total: total, needed: COMPARE_MIN_CHECKINS, ready: total >= COMPARE_MIN_CHECKINS,
      used: days.length, offDesk: offDesk, median: null, ok: false, hi: null, lo: null };
    if (!out.ready || !days.length) return out;
    out.median = median(days.map(function (d) { return d.breaks; }));
    function side(ds) {
      var by = {};
      SYMPTOMS.forEach(function (k) { by[k] = ds.length ? mean(ds.map(function (d) { return d.scores[k]; })) : null; });
      return { n: ds.length, breaks: ds.length ? mean(ds.map(function (d) { return d.breaks; })) : null,
        score: ds.length ? mean(SYMPTOMS.map(function (k) { return by[k]; })) : null, by: by };
    }
    out.hi = side(days.filter(function (d) { return d.breaks >= out.median; }));
    out.lo = side(days.filter(function (d) { return d.breaks < out.median; }));
    out.ok = out.hi.n >= COMPARE_MIN_GROUP && out.lo.n >= COMPARE_MIN_GROUP;
    return out;
  }

  /* ---- RX ----------------------------------------------------------------- */
  /* One id per exam date, as with check-ins: saving that date again edits it,
     and in B10 both devices' copies land on one row. */
  function rxId(day) { return "rx-" + day; }

  function isQuarter(v) { return Number.isFinite(v) && Math.abs(v / RX_STEP - Math.round(v / RX_STEP)) < 1e-9; }
  function blank(v) { return v == null || String(v).trim() === ""; }

  /* Spherical equivalent: sphere plus half the cylinder. Right in plus- and
     minus-cylinder notation alike. */
  function rxSE(eye) { return eye.sph + eye.cyl / 2; }

  /* One exam as typed in, to { errors: [text], exam: cleaned or null }.
     A blank cylinder is 0, because that is what a blank means on a slip;
     a blank sphere is an error, never a guess. The axis is needed only with
     a cylinder, and dropped without one. */
  function checkRx(input, today) {
    input = isObj(input) ? input : {};
    var errs = [], out = { day: input.day, dilated: input.dilated === true };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.day) || ymd(parseYmd(out.day)) !== out.day) errs.push("Enter the exam date.");
    else if (out.day > today) errs.push("The exam date is in the future.");
    EYES.forEach(function (k) {
      var e = isObj(input[k]) ? input[k] : {}, name = k === "od" ? "Right eye" : "Left eye";
      var sph = blank(e.sph) ? NaN : Number(e.sph);
      var cyl = blank(e.cyl) ? 0 : Number(e.cyl);
      var axis = blank(e.axis) ? null : Number(e.axis);
      if (!isQuarter(sph) || sph < RX_SPH_MIN || sph > RX_SPH_MAX)
        errs.push(name + ": sphere must be " + RX_SPH_MIN + " to +" + RX_SPH_MAX + ", in steps of 0.25.");
      if (!isQuarter(cyl) || Math.abs(cyl) > RX_CYL_MAX)
        errs.push(name + ": cylinder must be -" + RX_CYL_MAX + " to +" + RX_CYL_MAX + ", in steps of 0.25, or blank.");
      else if (cyl !== 0 && !(Number.isInteger(axis) && axis >= 0 && axis <= 180))
        errs.push(name + ": a cylinder needs an axis from 0 to 180.");
      out[k] = { sph: sph, cyl: cyl + 0, axis: cyl === 0 ? null : axis };   // + 0 turns -0 into 0
    });
    return { errors: errs, exam: errs.length ? null : out };
  }

  /* Saves a checked exam over any earlier one for its date. `fromDay` is the
     date it was opened for editing under: a moved exam leaves a tombstone
     there, not a copy. Returns true if it replaced a live exam. */
  function setRx(records, exam, now, fromDay) {
    if (fromDay && fromDay !== exam.day) removeRecord(records, rxId(fromDay), now);
    var id = rxId(exam.day), rec = records.filter(function (r) { return r.id === id; })[0];
    var replaced = !!rec && !rec.deletedAt;
    var data = { od: exam.od, os: exam.os, dilated: exam.dilated, updatedAt: now };
    if (rec) { Object.assign(rec, data); delete rec.deletedAt; }
    else records.push(Object.assign({ id: id, kind: "rx", day: exam.day, at: now }, data));
    return replaced;
  }

  /* Live exams, oldest first. A malformed row (a bad sync) is skipped, not
     drawn as a zero. */
  function rxExams(records) {
    return records.filter(function (r) {
      return r.kind === "rx" && !r.deletedAt && EYES.every(function (k) {
        return isObj(r[k]) && Number.isFinite(r[k].sph) && Number.isFinite(r[k].cyl);
      });
    }).sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
  }

  /* Change in spherical equivalent from exam a to exam b, per eye. `noise`
     is true inside the band: a change that small may not be real. */
  function rxChange(a, b) {
    var out = {};
    EYES.forEach(function (k) {
      var d = rxSE(b[k]) - rxSE(a[k]);
      out[k] = { delta: d, noise: Math.abs(d) <= RX_NOISE_D + 1e-9 };
    });
    return out;
  }

  /* Same day n months on, clamped to the month's end (31 Jan + 1 = 28 Feb). */
  function addMonths(key, n) {
    var d = parseYmd(key), y = d.getFullYear(), m = d.getMonth() + n;
    return ymd(new Date(y, m, Math.min(d.getDate(), new Date(y, m + 1, 0).getDate())));
  }

  /* The day the next dilated exam is due, or null if none is logged. Only
     dilated exams count: a glasses check without drops doesn't see the
     retina, which is what the yearly exam is for. */
  function examDue(records) {
    var last = rxExams(records).filter(function (r) { return r.dilated === true; }).pop();
    return last ? addMonths(last.day, EXAM_INTERVAL_MONTHS) : null;
  }

  /* ---- SYNC --------------------------------------------------------------- */
  /* Only `records` sync, as rows of one Turso table. These columns are pulled
     out of a record; everything else in it rides in `data` as JSON. */
  var SYNC_COLS = ["id", "kind", "day", "updatedAt", "deletedAt"];
  /* A push sends records edited since the last push's snapshot, minus this
     margin, so a clock corrected backwards by NTP can't strand an edit behind
     the mark. A record sent twice is a no-op upsert.
     ponytail: a backward jump larger than this still strands an edit until it
     is edited again. Reset pushMark to 0 to re-push everything if that bites. */
  var PUSH_MARGIN_MS = 10 * 60000;
  var PULL_PAGE = 500;
  var PUSH_CHUNK = 200;

  /* `seq` is not in the original B10 spec (A9). The pull cursor can't be
     updatedAt: that is when a record was written, not when the cloud got it,
     so a walk logged offline at 10:00 and pushed at 14:00 sits below a cursor
     another device moved to 12:00, and is never pulled. seq is assigned inside
     the upsert, and the server runs writes one at a time, so seq order is
     commit order with no gaps filled in later.
     Last-write-wins stays on updatedAt (device clocks; see the B10 Ceiling).
     On an exact tie the tombstone wins, here and in beats(), so two devices
     can never settle on different answers. */
  var SQL = {
    create: "CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, day TEXT, " +
            "data TEXT NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER, deviceId TEXT, seq INTEGER NOT NULL)",
    index:  "CREATE INDEX IF NOT EXISTS records_seq ON records (seq)",
    upsert: "INSERT INTO records (id, kind, day, data, updatedAt, deletedAt, deviceId, seq) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records)) " +
            "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, day = excluded.day, data = excluded.data, " +
            "updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, deviceId = excluded.deviceId, seq = excluded.seq " +
            "WHERE excluded.updatedAt > records.updatedAt OR (excluded.updatedAt = records.updatedAt " +
            "AND excluded.deletedAt IS NOT NULL AND records.deletedAt IS NULL)",
    pull:   "SELECT id, kind, day, data, updatedAt, deletedAt, seq FROM records WHERE seq > ? ORDER BY seq LIMIT " + PULL_PAGE
  };

  /* What you paste to the base URL fetch() can call. Turso shows libsql://,
     which is the same host over https. Null if it can't be a URL. */
  function syncBase(url) {
    var u = String(url == null ? "" : url).trim().replace(/^libsql:\/\//i, "https://").replace(/\/+$/, "");
    return /^https?:\/\/[^\/\s?#]+(\/[^\s?#]*)?$/i.test(u) ? u : null;
  }

  /* Hrana values travel as strings so a 64-bit integer survives JSON. */
  function hranaArg(v) {
    if (v == null) return { type: "null" };
    if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
    return { type: "text", value: String(v) };
  }
  function hranaVal(c) {
    if (!c || c.type === "null") return null;
    if (c.type === "integer" || c.type === "float") return Number(c.value);
    return c.value;
  }

  /* A record → the upsert's arguments, in SQL.upsert's column order. */
  function rowArgs(r, deviceId) {
    var data = {};
    Object.keys(r).forEach(function (k) { if (SYNC_COLS.indexOf(k) < 0) data[k] = r[k]; });
    return [r.id, r.kind, r.day == null ? null : r.day, JSON.stringify(data),
            r.updatedAt, r.deletedAt ? r.deletedAt : null, deviceId];
  }

  /* A pulled row → a record, or null if the row is unusable. A bad row is
     skipped, never allowed to throw away the rest of the page. */
  function fromRow(row) {
    if (!row || typeof row.id !== "string" || !row.id || typeof row.kind !== "string") return null;
    var at = row.updatedAt == null ? NaN : Number(row.updatedAt), data;   // Number(null) is 0
    if (!Number.isFinite(at)) return null;
    try { data = JSON.parse(row.data); } catch (e) { return null; }
    if (!isObj(data)) return null;
    var rec = data;
    SYNC_COLS.forEach(function (k) { delete rec[k]; });
    rec.id = row.id;
    rec.kind = row.kind;
    if (row.day != null) rec.day = row.day;
    rec.updatedAt = at;
    if (row.deletedAt != null && Number(row.deletedAt)) rec.deletedAt = Number(row.deletedAt);
    return rec;
  }

  /* Does `incoming` replace `local`? Newer wins: a tombstone beats an older
     live record, a newer live record beats an older tombstone (A5). */
  function beats(incoming, local) {
    if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt;
    return !!incoming.deletedAt && !local.deletedAt;
  }

  /* Union by id. A record is only ever added or replaced by a newer copy of
     itself, never removed, so an empty pull, an empty cloud or a wrong
     database can't shrink the local log (Phase 0, question 2). */
  function mergeRecords(local, incoming) {
    var out = local.slice(), at = {}, added = 0, replaced = 0;
    out.forEach(function (r, i) { at[r.id] = i; });
    incoming.forEach(function (r) {
      if (!r) return;
      var i = at[r.id];
      if (i === undefined) { at[r.id] = out.length; out.push(r); added++; }
      else if (beats(r, out[i])) { out[i] = r; replaced++; }
    });
    return { records: out, added: added, replaced: replaced };
  }

  /* Records to push: edited since the last push's snapshot, less the margin.
     mark 0 (never pushed) sends everything; an empty device sends nothing. */
  function pushSet(records, mark) {
    var from = mark > 0 ? mark - PUSH_MARGIN_MS : -Infinity;
    return records.filter(function (r) { return r.updatedAt >= from; });
  }


  /* ---- EXPORT ------------------------------------------------------------- */

  /* A backup holds what the user logged and how they set the app up. It leaves
     out `sync` (the token) and `outdoorRun` (a timer that is local-only until
     stopped), the same two things sync leaves out. */
  var BACKUP_FORMAT = "vis-backup";

  function makeBackup(state, now) {
    return {
      format: BACKUP_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: now,
      settings: state.settings,
      records: state.records
    };
  }

  /* File text in, { error } or { records, settings, skipped, version, exportedAt }.
     A file from a newer build is refused, not guessed at: reading it with this
     build's rules could drop fields the newer build relies on. A record that
     can't be used is counted and left out; the rest still load. */
  function parseBackup(text) {
    var raw;
    try { raw = JSON.parse(text); }
    catch (e) { return { error: "That file isn't JSON, so it isn't a backup from this app. Nothing was changed." }; }
    if (!isObj(raw) || raw.format !== BACKUP_FORMAT || !Array.isArray(raw.records))
      return { error: "That JSON isn't a vis backup. Nothing was changed." };
    var v = Number(raw.version);
    if (!(v >= 1)) return { error: "The backup has no version number. Nothing was changed." };
    if (v > SCHEMA_VERSION)
      return { error: "That backup is from a newer version of the app (schema v" + v + "; this one reads v" + SCHEMA_VERSION + "). Nothing was changed." };
    var skipped = 0;
    var records = raw.records.filter(function (r) {
      var ok = isObj(r) && typeof r.id === "string" && r.id !== "" && typeof r.kind === "string" &&
               /^\d{4}-\d{2}-\d{2}$/.test(r.day) && Number.isFinite(r.updatedAt);
      if (!ok) skipped++;
      return ok;
    });
    /* migrate() heals each settings field and drops what it can't read. */
    var settings = migrate({ version: v, settings: raw.settings }).settings;
    return { records: records, settings: settings, skipped: skipped, version: v,
             exportedAt: Number.isFinite(raw.exportedAt) ? raw.exportedAt : null };
  }

  /* The two on-switches stay as this device has them. Reminders and the
     check-in nudge are decided per device (the phone has no break reminders),
     and turning one on also asks for notification permission, which a restore
     must not do silently. */
  function restoreSettings(current, incoming) {
    var s = JSON.parse(JSON.stringify(incoming));
    s.breaks.enabled = current.breaks.enabled;
    s.checkin.nudge = current.checkin.nudge;
    return s;
  }

  /* One cell. Only numbers and fixed words reach here, so there is no
     formula-injection case, but quoting is still done for commas and quotes. */
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    var t = String(v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  /* Local clock time of a moment, HH:MM:SS. */
  function hms(t) {
    var d = new Date(t);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  /* One table per kind, because the columns differ. Removed records (tombstones)
     are left out: a CSV is for reading, the JSON backup keeps the tombstones. */
  var CSV_KINDS = {
    breaks: {
      kind: "break",
      head: ["day", "time"],
      row: function (r) { return [r.day, Number.isFinite(r.at) ? hms(r.at) : ""]; }
    },
    outdoor: {
      kind: "outdoor",
      head: ["day", "seconds", "minutes", "source", "estimate"],
      /* A "quick" entry is a +15 min tap, not a measured walk, so it says so. */
      row: function (r) {
        var sec = Number.isFinite(r.seconds) ? r.seconds : null;
        return [r.day, sec, sec === null ? "" : Math.round(sec / 6) / 10, r.source === "quick" ? "quick" : "timed",
                r.source === "quick" ? "yes" : "no"];
      }
    },
    symptoms: {
      kind: "checkin",
      head: ["day"].concat(SYMPTOMS),
      row: function (r) { return [r.day].concat(SYMPTOMS.map(function (k) { return isObj(r.scores) ? r.scores[k] : ""; })); }
    },
    rx: {
      kind: "rx",
      head: ["day", "od_sph", "od_cyl", "od_axis", "od_se", "os_sph", "os_cyl", "os_axis", "os_se", "dilated"],
      row: function (r) {
        var out = [r.day];
        EYES.forEach(function (k) {
          var e = isObj(r[k]) ? r[k] : {};
          var ok = Number.isFinite(e.sph) && Number.isFinite(e.cyl);
          out.push(ok ? e.sph : "", ok ? e.cyl : "", Number.isFinite(e.axis) ? e.axis : "", ok ? rxSE(e) : "");
        });
        out.push(r.dilated === true ? "yes" : "no");
        return out;
      }
    }
  };

  function toCsv(which, records) {
    var spec = CSV_KINDS[which];
    var rows = records.filter(function (r) { return r.kind === spec.kind && !r.deletedAt; })
      .sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : (a.at || 0) - (b.at || 0); });
    return [spec.head].concat(rows.map(spec.row)).map(function (cells) { return cells.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_DAY_START_HOUR: MAX_DAY_START_HOUR,
    BREAK_INTERVAL_MIN: BREAK_INTERVAL_MIN,
    LOOK_SECONDS: LOOK_SECONDS,
    SNOOZE_MIN: SNOOZE_MIN,
    SLEPT_AFTER_MS: SLEPT_AFTER_MS,
    SYMPTOMS: SYMPTOMS,
    SCORE_MAX: SCORE_MAX,
    DONE_BREAKS: DONE_BREAKS,
    GRACE_PER_MONTH: GRACE_PER_MONTH,
    defaultState: defaultState,
    migrate: migrate,
    ymd: ymd,
    parseYmd: parseYmd,
    addDays: addDays,
    dayOf: dayOf,
    themeId: themeId,
    breakBlocked: breakBlocked,
    breakDue: breakDue,
    countBreaks: countBreaks,
    countExercises: countExercises,
    OUTDOOR_TARGET_MIN: OUTDOOR_TARGET_MIN,
    QUICK_ADD_MIN: QUICK_ADD_MIN,
    MAX_RUN_MS: MAX_RUN_MS,
    MIN_RUN_SEC: MIN_RUN_SEC,
    outdoorDay: outdoorDay,
    startRun: startRun,
    runMs: runMs,
    runNeedsReview: runNeedsReview,
    stopRun: stopRun,
    discardRun: discardRun,
    quickAdd: quickAdd,
    removeRecord: removeRecord,
    checkinId: checkinId,
    findCheckin: findCheckin,
    validScores: validScores,
    setCheckin: setCheckin,
    pastNudge: pastNudge,
    dayIndex: dayIndex,
    dayStatus: dayStatus,
    streak: streak,
    COMPARE_MIN_CHECKINS: COMPARE_MIN_CHECKINS,
    COMPARE_MIN_GROUP: COMPARE_MIN_GROUP,
    symptomCompare: symptomCompare,
    RX_STEP: RX_STEP,
    RX_NOISE_D: RX_NOISE_D,
    EXAM_INTERVAL_MONTHS: EXAM_INTERVAL_MONTHS,
    EYES: EYES,
    rxId: rxId,
    rxSE: rxSE,
    checkRx: checkRx,
    setRx: setRx,
    rxExams: rxExams,
    rxChange: rxChange,
    addMonths: addMonths,
    examDue: examDue,
    PUSH_MARGIN_MS: PUSH_MARGIN_MS,
    PULL_PAGE: PULL_PAGE,
    PUSH_CHUNK: PUSH_CHUNK,
    SQL: SQL,
    syncBase: syncBase,
    hranaArg: hranaArg,
    hranaVal: hranaVal,
    rowArgs: rowArgs,
    fromRow: fromRow,
    beats: beats,
    mergeRecords: mergeRecords,
    pushSet: pushSet,
    BACKUP_FORMAT: BACKUP_FORMAT,
    makeBackup: makeBackup,
    parseBackup: parseBackup,
    restoreSettings: restoreSettings,
    CSV_KINDS: CSV_KINDS,
    toCsv: toCsv
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.Vis = root.Vis || {}).logic = api;
})(this);
