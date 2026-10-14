/* Self-check for logic.js. Run: node tools/check-logic.js
   Silent on success apart from the last line; any failed assert throws. */
"use strict";
const assert = require("assert");
const L = require("../logic.js");

/* ---- date keys: local time, rollover up to 06:00 ---- */
const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();   // October 2026, local
assert.strictEqual(L.dayOf(at(11, 2, 30), 0), "2026-10-11", "no rollover: 02:30 is today");
assert.strictEqual(L.dayOf(at(11, 2, 30), 4), "2026-10-10", "rollover 04:00: 02:30 is yesterday");
assert.strictEqual(L.dayOf(at(11, 4, 0), 4), "2026-10-11", "rollover 04:00: 04:00 is today");
assert.strictEqual(L.dayOf(at(1, 0, 10), 6), "2026-09-30", "rollover crosses a month");
assert.strictEqual(L.dayOf(new Date(2027, 0, 1, 1, 0).getTime(), 3), "2026-12-31", "rollover crosses a year");
assert.strictEqual(L.ymd(L.parseYmd("2026-03-07")), "2026-03-07", "parseYmd round-trips");

/* ---- migrate: never throws, never drops, never downgrades ---- */
const fresh = L.defaultState();
assert.deepStrictEqual(L.migrate(null), fresh, "null → defaults");
assert.deepStrictEqual(L.migrate([1, 2]), fresh, "array → defaults");
assert.deepStrictEqual(L.migrate({}), fresh, "unversioned empty → defaults at v1");

const kept = L.migrate({ version: 1, settings: { theme: "light", dayStartHour: 4 }, future: { x: 1 } });
assert.strictEqual(kept.settings.theme, "light", "saved theme kept");
assert.strictEqual(kept.settings.dayStartHour, 4, "saved rollover kept");
assert.deepStrictEqual(kept.future, { x: 1 }, "unknown field survives");

assert.strictEqual(L.migrate({ version: 3 }).version, 3, "newer build's version is not lowered");

const healed = L.migrate({ version: 1, settings: { theme: "neon", dayStartHour: 9 } });
assert.strictEqual(healed.settings.theme, "system", "unknown theme → system");
assert.strictEqual(healed.settings.dayStartHour, 0, "rollover past 06:00 → 0");
assert.strictEqual(L.migrate({ settings: { dayStartHour: "x" } }).settings.dayStartHour, 0, "non-number rollover → 0");

/* ---- break settings heal one field at a time ---- */
const B = L.defaultState().settings.breaks;
assert.strictEqual(B.enabled, false, "reminders ship off");
assert.deepStrictEqual(B.days, [1, 2, 3, 4, 5], "desk days default Mon–Fri (A1)");
const part = L.migrate({ version: 1, settings: { breaks: { enabled: true, quiet: { from: "23:30" } } } }).settings.breaks;
assert.strictEqual(part.enabled, true, "saved enabled kept");
assert.deepStrictEqual(part.days, [1, 2, 3, 4, 5], "missing days → default");
assert.deepStrictEqual(part.quiet, { enabled: true, from: "23:30", to: "07:00" }, "quiet merges field by field");
const bad = L.migrate({ settings: { breaks: { enabled: "yes", days: [6, 1, 1, 9, "2", 0.5], sound: 0, quiet: { enabled: false, from: "25:00", to: "7:00" } } } }).settings.breaks;
assert.strictEqual(bad.enabled, false, "non-boolean enabled → off, never silently on");
assert.deepStrictEqual(bad.days, [1, 6], "days: deduped, sorted, junk dropped");
assert.strictEqual(bad.sound, true, "only an explicit false mutes");
assert.deepStrictEqual(bad.quiet, { enabled: false, from: "22:00", to: "07:00" }, "bad times → defaults, off kept");
assert.deepStrictEqual(L.migrate({ settings: { breaks: { days: [] } } }).settings.breaks.days, [], "no days is a real answer");
assert.deepStrictEqual(L.migrate({ records: "x" }).records, [], "non-array records → []");

/* ---- break schedule ---- */
const cfg = { days: [1, 2, 3, 4, 5], quiet: { enabled: true, from: "22:00", to: "07:00" } };
const mon = (h, m) => new Date(2026, 9, 12, h, m);            // Mon 12 Oct 2026
assert.strictEqual(L.breakBlocked(cfg, mon(10, 0)), null, "Mon 10:00 fires");
assert.strictEqual(L.breakBlocked(cfg, new Date(2026, 9, 11, 10, 0)), "day", "Sunday is not ticked");
assert.strictEqual(L.breakBlocked(cfg, mon(22, 0)), "quiet", "quiet starts at 22:00");
assert.strictEqual(L.breakBlocked(cfg, mon(6, 59)), "quiet", "wrapped window still quiet at 06:59");
assert.strictEqual(L.breakBlocked(cfg, mon(7, 0)), null, "quiet ends at 07:00");
assert.strictEqual(L.breakBlocked({ days: [1], quiet: { enabled: true, from: "13:00", to: "14:00" } }, mon(13, 30)), "quiet", "same-day window");
assert.strictEqual(L.breakBlocked({ days: [1], quiet: { enabled: true, from: "13:00", to: "13:00" } }, mon(13, 0)), null, "zero-length window is never quiet");
assert.strictEqual(L.breakBlocked({ days: [1], quiet: { enabled: false, from: "00:00", to: "23:59" } }, mon(12, 0)), null, "quiet off");

const T = 1e12;
assert.strictEqual(L.breakDue(T - 1, T), "wait");
assert.strictEqual(L.breakDue(T, T), "fire");
assert.strictEqual(L.breakDue(T + 60000, T), "fire", "a minute late (throttled window) still fires");
assert.strictEqual(L.breakDue(T + L.SLEPT_AFTER_MS + 1, T), "slept", "past the gap: the laptop slept");

const recs = [
  { kind: "break", day: "2026-10-12" }, { kind: "break", day: "2026-10-12" },
  { kind: "break", day: "2026-10-12", deletedAt: 5 }, { kind: "break", day: "2026-10-11" },
  { kind: "checkin", day: "2026-10-12" }
];
assert.strictEqual(L.countBreaks(recs, "2026-10-12"), 2, "counts that day's live breaks only");
assert.strictEqual(L.countBreaks([], "2026-10-12"), 0);

/* ---- check-in: one record per day, all three scores or nothing ---- */
assert.strictEqual(L.addDays("2026-10-01", -1), "2026-09-30", "addDays back across a month");
assert.strictEqual(L.addDays("2026-12-31", 1), "2027-01-01", "addDays forward across a year");

const C = L.defaultState().settings.checkin;
assert.deepStrictEqual(C, { nudge: false, time: "21:00" }, "nudge ships off, at 21:00");
assert.deepStrictEqual(L.migrate({ version: 1, settings: { theme: "dark" } }).settings.checkin, C, "a B2 save gains the default, nudge still off");
assert.deepStrictEqual(L.migrate({ settings: { checkin: { nudge: "yes", time: "9pm" } } }).settings.checkin, C, "non-boolean nudge → off, bad time → 21:00");
assert.deepStrictEqual(L.migrate({ settings: { checkin: { nudge: true, time: "20:30" } } }).settings.checkin, { nudge: true, time: "20:30" }, "saved nudge kept");

const ci = [{ kind: "break", day: "2026-10-12", id: "b1" }];
assert.strictEqual(L.setCheckin(ci, "2026-10-12", { dryness: 1, headache: 0, blur: 2 }, 100), true);
assert.strictEqual(L.setCheckin(ci, "2026-10-12", { dryness: 3, headache: 3, blur: 0, extra: 9 }, 200), true, "second save the same day");
assert.strictEqual(ci.filter((r) => r.kind === "checkin").length, 1, "a second save overwrites, never adds a second check-in");
assert.deepStrictEqual(L.findCheckin(ci, "2026-10-12"),
  { id: "checkin-2026-10-12", kind: "checkin", day: "2026-10-12", scores: { dryness: 3, headache: 3, blur: 0 }, updatedAt: 200 },
  "newest scores, newest updatedAt, unknown score keys dropped");
assert.strictEqual(L.findCheckin(ci, "2026-10-11"), null, "another day is blank");
assert.strictEqual(L.countBreaks(ci, "2026-10-12"), 1, "a check-in is not a break");

const before = JSON.stringify(ci);
[{ dryness: 1, headache: 0 }, { dryness: 1, headache: 0, blur: 4 }, { dryness: -1, headache: 0, blur: 0 },
 { dryness: "2", headache: 0, blur: 0 }, { dryness: 1.5, headache: 0, blur: 0 }, { dryness: null, headache: 0, blur: 0 }, null
].forEach((bad) => assert.strictEqual(L.setCheckin(ci, "2026-10-12", bad, 300), false, "rejected: " + JSON.stringify(bad)));
assert.strictEqual(JSON.stringify(ci), before, "a rejected save changes nothing — a missing score is never stored as 0");

const tomb = [{ id: "checkin-2026-10-10", kind: "checkin", day: "2026-10-10", scores: { dryness: 0, headache: 0, blur: 0 }, updatedAt: 1, deletedAt: 2 }];
assert.strictEqual(L.findCheckin(tomb, "2026-10-10"), null, "a tombstoned check-in reads as blank");
L.setCheckin(tomb, "2026-10-10", { dryness: 2, headache: 1, blur: 1 }, 3);
assert.strictEqual(tomb.length, 1, "saving over a tombstone reuses the row");
assert.strictEqual(L.findCheckin(tomb, "2026-10-10").updatedAt, 3, "and brings it back");

/* ---- nudge time, measured from the rollover ---- */
const mo = (h, m) => new Date(2026, 9, 12, h, m);
assert.strictEqual(L.pastNudge(mo(20, 59), "21:00", 0), false, "20:59 is before a 21:00 nudge");
assert.strictEqual(L.pastNudge(mo(21, 0), "21:00", 0), true, "21:00 is due");
assert.strictEqual(L.pastNudge(mo(23, 59), "21:00", 0), true, "still due at 23:59");
assert.strictEqual(L.pastNudge(mo(0, 10), "21:00", 0), false, "00:10 is a new day, not yet due");
assert.strictEqual(L.pastNudge(mo(1, 0), "21:00", 4), true, "rollover 04:00: 01:00 is still the day that passed 21:00");
assert.strictEqual(L.pastNudge(mo(4, 0), "21:00", 4), false, "rollover 04:00: the new day starts not yet due");
assert.strictEqual(L.pastNudge(mo(23, 0), "00:30", 4), false, "a 00:30 nudge with a 04:00 rollover isn't due at 23:00");
assert.strictEqual(L.pastNudge(mo(0, 30), "00:30", 4), true, "it is due at 00:30");
assert.strictEqual(L.pastNudge(mo(3, 59), "00:30", 4), true, "and until the rollover");

/* ---- streak: desk days only (A1), Helth's monthly grace ---- */
const MF = [1, 2, 3, 4, 5];
const logDay = (key, breaks, checkin) => {
  const r = [];
  for (let i = 0; i < breaks; i++) r.push({ id: key + "-b" + i, kind: "break", day: key });
  if (checkin) r.push({ id: "checkin-" + key, kind: "checkin", day: key, scores: { dryness: 0, headache: 0, blur: 0 } });
  return r;
};
const done = (...keys) => keys.flatMap((k) => logDay(k, L.DONE_BREAKS, true));
const run = (recs, today, desk = MF) => L.streak(L.dayIndex(recs), today, desk);
const weekdays = (from, n) => { const out = []; for (let k = from; out.length < n; k = L.addDays(k, 1)) if (MF.includes(L.parseYmd(k).getDay())) out.push(k); return out; };
const MON12 = "2026-10-12";                                        // today in every case below
const WK = weekdays("2026-10-05", 5);                              // Mon 5 – Fri 9 Oct
const without = (keys, ...drop) => keys.filter((k) => !drop.includes(k));

assert.deepStrictEqual(L.dayIndex([...logDay("2026-10-05", 3, true), { kind: "break", day: "2026-10-05", deletedAt: 1 }, { kind: "rx", day: "2026-10-05" }]),
  { "2026-10-05": { breaks: 3, checkin: true } }, "dayIndex: live breaks and check-ins only");
const ix = L.dayIndex([...logDay("2026-10-05", 5, true), ...logDay("2026-10-06", 6, false), ...logDay("2026-10-07", 6, true), ...logDay("2026-10-10", 9, true)]);
assert.strictEqual(L.dayStatus(ix, "2026-10-05", MF), "miss", "5 breaks + check-in is a miss");
assert.strictEqual(L.dayStatus(ix, "2026-10-06", MF), "miss", "6 breaks, no check-in is a miss");
assert.strictEqual(L.dayStatus(ix, "2026-10-07", MF), "done", "6 breaks + check-in is done");
assert.strictEqual(L.dayStatus(ix, "2026-10-10", MF), "off", "a busy Saturday is still off while unticked");
assert.strictEqual(L.dayStatus(ix, "2026-10-11", [0]), "miss", "0 = Sunday");

assert.deepStrictEqual(run([], MON12), { current: 0, graced: [] }, "no records: 0");
assert.deepStrictEqual(run(done(...WK), MON12), { current: 5, graced: [] }, "Mon–Fri done, weekend off, today not over: 5");
assert.strictEqual(run(done(...WK, MON12), MON12).current, 6, "today done counts at once");
assert.strictEqual(run(done(...WK), MON12, [0, 1, 2, 3, 4, 5, 6]).current, 0, "every day a desk day: the weekend breaks it (the A1 failure)");
assert.strictEqual(run([...done(...WK), ...logDay("2026-10-10", 9, true)], MON12).current, 5, "a busy Saturday neither counts nor breaks");
assert.strictEqual(run([...done(...WK), ...logDay(MON12, 3, false)], MON12).current, 5, "today half done is not a miss yet");
assert.strictEqual(run(done("2026-10-04", "2026-10-11"), MON12, [0]).current, 2, "Sunday-only mask");
assert.deepStrictEqual(run([], MON12, []), { current: 0, graced: [] }, "no desk days: 0, and it returns");

assert.deepStrictEqual(run(done(...without(WK, "2026-10-07")), MON12), { current: 4, graced: ["2026-10-07"] },
  "one miss with the day before done: forgiven, not counted");
assert.deepStrictEqual(run(done(...without(WK, "2026-10-09")), MON12), { current: 4, graced: ["2026-10-09"] },
  "the last desk day missed, today not over: grace holds the run");
assert.strictEqual(run(done(...without(WK, "2026-10-07", "2026-10-08")), MON12).current, 1, "two misses in a row: grace bridges one, never two");
assert.deepStrictEqual(run(done(...without(weekdays("2026-09-28", 10), "2026-10-01", "2026-10-07")), MON12), { current: 5, graced: ["2026-10-07"] },
  "a second miss in the same month ends the run");
assert.deepStrictEqual(run(done(...without(weekdays("2026-09-28", 10), "2026-09-30", "2026-10-07")), MON12), { current: 8, graced: ["2026-10-07", "2026-09-30"] },
  "misses in different months each use their own month's grace");
const tombDay = logDay("2026-10-09", 6, true); tombDay[0].deletedAt = 9;
assert.strictEqual(run([...done(...without(WK, "2026-10-09")), ...tombDay, ...done("2026-10-08")], MON12).current, 4,
  "a deleted break drops a 6-break day to a miss");
/* The desk-day mask is read today, so it re-scores the past: ticking Saturday
   turns past Saturdays into misses. The UI says so next to the checkboxes. */
const three = done(...weekdays("2026-09-21", 15));
assert.strictEqual(run(three, MON12).current, 15, "three weeks Mon–Fri: 15");
assert.deepStrictEqual(run(three, MON12, [1, 2, 3, 4, 5, 6]), { current: 5, graced: ["2026-10-10"] }, "tick Saturday: 15 → 5");
const years = weekdays("2023-10-02", 782);
assert.strictEqual(run(done(...years), years[781]).current, 782, "three years of weekdays: the guard never cuts a real run");

/* ---- exercises: their own kind, never a break ---- */
const ex = (id, day, extra) => Object.assign({ id: id + day + Math.random(), kind: "exercise", exercise: id, day, at: 1, updatedAt: 1 }, extra);
const exRecs = [ex("palming", "2026-10-12"), ex("palming", "2026-10-12"), ex("blink", "2026-10-12"),
                ex("palming", "2026-10-11"), ex("rolls", "2026-10-12", { deletedAt: 5 })];
assert.deepStrictEqual(L.countExercises(exRecs, "2026-10-12"), { palming: 2, blink: 1 }, "counts per exercise, that day only, tombstones skipped");
assert.deepStrictEqual(L.countExercises([], "2026-10-12"), {}, "no records: empty map");
assert.strictEqual(L.countBreaks(exRecs, "2026-10-12"), 0, "exercises are not breaks");
assert.deepStrictEqual(L.dayIndex(exRecs), {}, "exercises don't touch the streak index");

/* ---- outdoor: timer, estimates, forgotten stop, tombstones ---- */
const T0 = at(12, 14, 0), MIN = 60000;
let st = L.defaultState();
assert.strictEqual(st.outdoorRun, null, "no timer by default");
assert.strictEqual(L.startRun(st, T0), true, "start");
assert.strictEqual(L.startRun(st, T0 + 5 * MIN), false, "a second start is refused");
assert.strictEqual(st.outdoorRun, T0, "...and doesn't move the first");
assert.strictEqual(L.migrate(JSON.parse(JSON.stringify(st))).outdoorRun, T0, "a running timer survives save and reload");
assert.strictEqual(L.runMs(st, T0 - 5 * MIN), 0, "a clock set back never reads negative");
let r1 = L.stopRun(st, T0 + 42 * MIN + 500, "o1", 0);
assert.strictEqual(r1.seconds, 42 * 60, "42 min 0.5 s logs 2520 whole seconds");
assert.strictEqual(r1.source, "timed"); assert.strictEqual(st.outdoorRun, null, "stopping clears the timer");
assert.strictEqual(L.stopRun(st, T0 + 50 * MIN, "o2", 0), null, "stop with nothing running logs nothing");

L.startRun(st, T0);
assert.strictEqual(L.stopRun(st, T0 + 59000, "o3", 0), null, "under a minute is a mis-tap, not logged");
assert.strictEqual(st.outdoorRun, null, "...and the timer is cleared");
assert.strictEqual(st.records.length, 1, "only the 42 min run exists");

/* A walk started at 23:30 belongs to the day it began, with or without rollover. */
const late = L.defaultState(); L.startRun(late, at(12, 23, 30));
assert.strictEqual(L.stopRun(late, at(13, 0, 30), "o4", 0).day, "2026-10-12", "started 23:30, stopped 00:30: day it began");
const early = L.defaultState(); L.startRun(early, at(13, 1, 0));
assert.strictEqual(L.stopRun(early, at(13, 1, 30), "o5", 4).day, "2026-10-12", "01:00 with a 04:00 rollover is still the 12th");

/* Forgotten stop: over four hours asks for minutes, and a reviewed figure is what is logged. */
const fg = L.defaultState(); L.startRun(fg, T0);
assert.strictEqual(L.runNeedsReview(fg, T0 + 4 * 60 * MIN), false, "exactly 4 h is still a run");
assert.strictEqual(L.runNeedsReview(fg, T0 + 4 * 60 * MIN + 1), true, "over 4 h needs review");
assert.strictEqual(fg.records.length, 0, "review changes nothing until answered");
assert.strictEqual(L.stopRun(fg, T0 + 9 * 60 * MIN, "o6", 0, 90 * 60).seconds, 5400, "reviewed 90 min is what's logged, not 9 h");
const fg2 = L.defaultState(); L.startRun(fg2, T0); L.discardRun(fg2);
assert.strictEqual(fg2.outdoorRun, null, "discard clears without logging");
const fg3 = Object.assign(L.defaultState(), { outdoorRun: T0 });
assert.strictEqual(L.stopRun(fg3, T0 + 9 * 60 * MIN, "o7", 0, 30.5), null, "a fractional review figure is refused");
assert.strictEqual(fg3.outdoorRun, T0, "...and the timer keeps running, so the walk isn't lost");
assert.strictEqual(L.stopRun(fg3, T0 + 9 * 60 * MIN, "o8", 0, 30), null, "a review figure under a minute is refused");
assert.strictEqual(fg3.outdoorRun + fg3.records.length, T0, "...timer kept, nothing logged");

/* Quick-add is an estimate and is kept apart from measured time. */
L.quickAdd(st.records, at(12, 18, 0), "q1", 0);
let d = L.outdoorDay(st.records, "2026-10-12");
assert.deepStrictEqual([d.timed, d.quick, d.entries.length], [2520, 900, 2], "42 min timed + 15 min estimate, kept apart");
assert.deepStrictEqual(d.entries.map(e => e.id), ["o1", "q1"], "entries in time order");
assert.strictEqual(L.removeRecord(st.records, "q1", at(12, 18, 5)), true, "remove");
assert.strictEqual(L.removeRecord(st.records, "q1", at(12, 18, 6)), false, "removing twice is a no-op");
d = L.outdoorDay(st.records, "2026-10-12");
assert.deepStrictEqual([d.timed, d.quick], [2520, 0], "a removed estimate drops out");
assert.ok(st.records.some(r => r.id === "q1" && r.deletedAt), "...as a tombstone, not a deletion");
assert.strictEqual(L.outdoorDay(st.records, "2026-10-11").entries.length, 0, "other days are empty");
assert.strictEqual(L.countBreaks(st.records, "2026-10-12"), 0, "outdoor time isn't a break");
assert.deepStrictEqual(L.dayIndex(st.records), {}, "outdoor time doesn't touch the streak");
assert.strictEqual(L.migrate({ version: 1, outdoorRun: "yesterday" }).outdoorRun, null, "a garbage timer value is dropped");
assert.strictEqual(L.migrate({ version: 1, outdoorRun: -5 }).outdoorRun, null, "a negative timer value is dropped");

/* ---- rx: checked input, one record per date, change vs the noise band ----
   Made-up prescriptions. A real one never goes in this repo. */
const eye = (sph, cyl = "", axis = "") => ({ sph, cyl, axis });
const exam = (day, od, os, dilated = false) => ({ day, od, os, dilated });
const TODAY = "2026-10-14";
let c = L.checkRx(exam("2026-03-02", eye("-3.00", "-0.50", "180"), eye("-3.25")), TODAY);
assert.deepStrictEqual(c.errors, [], "a normal slip passes");
assert.deepStrictEqual(c.exam.os, { sph: -3.25, cyl: 0, axis: null }, "blank cylinder is 0, no axis");
assert.strictEqual(L.rxSE(c.exam.od), -3.25, "SE = sphere + cylinder / 2");
assert.strictEqual(L.rxSE({ sph: -3.5, cyl: 0.5 }), -3.25, "plus-cylinder notation gives the same SE");
assert.strictEqual(L.checkRx(exam("2026-03-02", eye(""), eye("-3")), TODAY).errors[0], "Right eye: sphere must be -30 to +25, in steps of 0.25.", "blank sphere is an error, never 0");
assert.strictEqual(L.checkRx(exam("2026-03-02", eye("-325"), eye("-3")), TODAY).errors.length, 1, "a dropped decimal point is caught");
assert.strictEqual(L.checkRx(exam("2026-03-02", eye("-3.1"), eye("-3")), TODAY).errors.length, 1, "not a quarter step");
assert.strictEqual(L.checkRx(exam("2026-03-02", eye("-3", "-1"), eye("-3")), TODAY).errors[0], "Right eye: a cylinder needs an axis from 0 to 180.", "cylinder without axis");
assert.strictEqual(L.checkRx(exam("2026-03-02", eye("-3", "-1", "181"), eye("-3")), TODAY).errors.length, 1, "axis over 180");
assert.strictEqual(L.checkRx(exam("2026-03-02", eye("-3", "0", "90"), eye("-3")), TODAY).exam.od.axis, null, "an axis without a cylinder is dropped");
assert.strictEqual(L.checkRx(exam("2026-10-15", eye("-3"), eye("-3")), TODAY).errors[0], "The exam date is in the future.");
assert.strictEqual(L.checkRx(exam("2026-02-30", eye("-3"), eye("-3")), TODAY).errors[0], "Enter the exam date.", "an impossible date");
assert.strictEqual(L.checkRx(null, TODAY).errors.length, 3, "garbage in: three errors, no throw");
assert.strictEqual(Object.is(L.checkRx(exam("2026-03-02", eye("-3", "-0"), eye("-3")), TODAY).exam.od.cyl, 0), true, "-0 is stored as 0");

const rx = [];
assert.strictEqual(L.setRx(rx, L.checkRx(exam("2025-02-10", eye("-2.75"), eye("-3"), true), TODAY).exam, 1), false, "first save is not a replace");
L.setRx(rx, L.checkRx(exam("2026-03-02", eye("-3", "-0.5", "180"), eye("-3.25")), TODAY).exam, 2);
assert.strictEqual(rx.length, 2);
assert.strictEqual(rx[1].id, "rx-2026-03-02", "id is the exam date");
assert.strictEqual(L.setRx(rx, L.checkRx(exam("2026-03-02", eye("-3.5"), eye("-3.25")), TODAY).exam, 3), true, "same date edits in place");
assert.strictEqual(rx.length, 2, "...without a second record");
L.setRx(rx, L.checkRx(exam("2026-03-09", eye("-3.5"), eye("-3.25")), TODAY).exam, 4, "2026-03-02");
assert.ok(rx.some(r => r.id === "rx-2026-03-02" && r.deletedAt), "a moved exam leaves a tombstone at its old date");
assert.deepStrictEqual(L.rxExams(rx).map(r => r.day), ["2025-02-10", "2026-03-09"], "live exams, oldest first");
assert.deepStrictEqual(L.rxExams([{ kind: "rx", day: "2026-01-01", od: {} }]), [], "a malformed row is skipped");

const ch = L.rxChange(...L.rxExams(rx));
assert.deepStrictEqual(ch.od, { delta: -0.75, noise: false }, "right eye -0.75 D: outside the band");
assert.deepStrictEqual(ch.os, { delta: -0.25, noise: true }, "left eye -0.25 D: inside, may be noise");
assert.strictEqual(L.rxChange({ od: { sph: -3, cyl: 0 }, os: { sph: -3, cyl: 0 } }, { od: { sph: -3.5, cyl: 0 }, os: { sph: -2.5, cyl: 0 } }).od.noise, true, "exactly the band edge counts as inside");

assert.strictEqual(L.examDue(rx), "2026-02-10", "due a year after the last dilated exam");
assert.strictEqual(L.examDue(rx.filter(r => !r.dilated)), null, "no dilated exam logged: no due date, not a guess");
assert.strictEqual(L.addMonths("2026-01-31", 1), "2026-02-28", "month end clamps");
assert.strictEqual(L.addMonths("2024-02-29", 12), "2025-02-28", "leap day clamps");
assert.deepStrictEqual(L.dayIndex(rx), {}, "exams don't touch the streak");

/* ---- symptom comparison: hidden until 14 check-ins, desk days only, both n's kept ---- */
{   // own scope: the names below are short on purpose
const closeTo = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg + " (got " + a + ")");
const DESK = [1, 2, 3, 4, 5];
/* nth weekday on or after 2026-09-01 (a Tuesday), so every key is a desk day. */
const deskKeys = n => { const out = []; let d = "2026-09-01"; while (out.length < n) { if (DESK.includes(L.parseYmd(d).getDay())) out.push(d); d = L.addDays(d, 1); } return out; };
/* One check-in per [breaks, dryness, headache, blur] row, on consecutive deskKeys. */
const logDays = rows => {
  const rec = [];
  deskKeys(rows.length).forEach((day, i) => {
    const [n, d, h, b] = rows[i];
    for (let k = 0; k < n; k++) rec.push({ id: "br-" + i + "-" + k, kind: "break", day, at: k, updatedAt: k });
    L.setCheckin(rec, day, { dryness: d, headache: h, blur: b }, 1);
  });
  return rec;
};
const cmp = rec => L.symptomCompare(rec, L.dayIndex(rec), DESK);
const eight = (n, s) => Array.from({ length: 8 }, () => [n, ...s]);

const thirteen = cmp(logDays(Array.from({ length: 13 }, (_, i) => [i, 1, 1, 1])));
assert.strictEqual(thirteen.ready, false, "13 check-ins: card stays hidden");
assert.strictEqual(thirteen.total, 13);
assert.strictEqual(thirteen.hi, null, "nothing is computed before the gate opens");
assert.strictEqual(cmp(logDays(Array.from({ length: 14 }, (_, i) => [i, 1, 1, 1]))).ready, true, "the 14th check-in opens it");

const split = cmp(logDays([...eight(2, [3, 2, 1]), ...eight(8, [1, 0, 1])]));
assert.strictEqual(split.ready && split.ok, true);
assert.strictEqual(split.median, 5, "median of 8 twos and 8 eights is 5");
assert.deepStrictEqual([split.hi.n, split.lo.n], [8, 8], "both n's are reported");
closeTo(split.hi.score, 2 / 3, "days at or above the median: mean score");
closeTo(split.lo.score, 2, "days below the median: mean score");
closeTo(split.hi.by.dryness, 1, "per-symptom mean, high side");
closeTo(split.lo.by.dryness, 3, "per-symptom mean, low side");
closeTo(split.hi.breaks, 8, "mean breaks, high side");

const onMedian = cmp(logDays([...eight(4, [3, 3, 3]), ...Array.from({ length: 7 }, () => [6, 0, 0, 0]), [4, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]]));
assert.strictEqual(onMedian.median, 4);
assert.strictEqual(onMedian.hi.n, 18, "a day exactly on the median goes to 'at or above'");
assert.strictEqual(onMedian.lo.n, 0);
assert.strictEqual(onMedian.ok, false, "no day below the median: nothing to compare");

const flat = cmp(logDays(Array.from({ length: 14 }, () => [6, 1, 1, 1])));
assert.strictEqual(flat.ok, false, "same break count every day: no comparison");
assert.strictEqual(flat.lo.n, 0);

const thin = cmp(logDays([...Array.from({ length: 12 }, () => [5, 0, 0, 0]), [1, 3, 3, 3], [1, 3, 3, 3]]));
assert.deepStrictEqual([thin.hi.n, thin.lo.n], [12, 2], "n's still reported when one side is thin");
assert.strictEqual(thin.ok, false, "2 days is not enough to show a mean");

const mixed = logDays([...eight(2, [3, 2, 1]), ...eight(8, [1, 0, 1])]);
L.setCheckin(mixed, "2026-10-10", { dryness: 3, headache: 3, blur: 3 }, 1);   // a Saturday
L.setCheckin(mixed, "2026-10-11", { dryness: 3, headache: 3, blur: 3 }, 1);   // a Sunday
const wk = cmp(mixed);
assert.deepStrictEqual([wk.total, wk.used, wk.offDesk], [18, 16, 2], "weekend check-ins count toward 14 but not the comparison");
closeTo(wk.lo.score, 2, "weekend scores do not leak into a group");
assert.strictEqual(L.symptomCompare(mixed, L.dayIndex(mixed), [0, 6]).used, 2, "desk days come from the setting, not Mon–Fri");

const dead = logDays(Array.from({ length: 14 }, (_, i) => [i, 1, 1, 1]));
dead[dead.length - 1].deletedAt = 9;
assert.strictEqual(cmp(dead).total, 13, "a removed check-in doesn't count");
const bad = logDays(Array.from({ length: 14 }, (_, i) => [i, 1, 1, 1]));
delete bad.filter(r => r.kind === "checkin")[0].scores.blur;
assert.strictEqual(cmp(bad).total, 13, "a check-in with a blank score is never counted as a 0");

const noBreaks = logDays([...eight(0, [2, 2, 2]), ...eight(7, [0, 0, 0])]);
assert.deepStrictEqual([cmp(noBreaks).lo.n, cmp(noBreaks).hi.n], [8, 8], "a check-in day with no breaks is a 0-break day");
assert.strictEqual(cmp([]).ready, false, "no records: hidden, no throw");

}

/* ---- theme ---- */
assert.strictEqual(L.themeId("system", true), "ink");
assert.strictEqual(L.themeId("system", false), "paper");
assert.strictEqual(L.themeId("dark", false), "ink");
assert.strictEqual(L.themeId("light", true), "paper");
assert.strictEqual(L.themeId(undefined, false), "paper", "missing preference follows the system");

/* ---- sync (B10): the merge, the empty-device guard, the seq cursor ---- */
{
const rec = (id, at, extra) => Object.assign({ id, kind: "break", day: "2026-10-12", at, updatedAt: at }, extra);

/* migrate: a v1 save from before B10 keeps its records and gets sync defaults */
const old = L.migrate({ version: 1, records: [rec("a", 5)], outdoorRun: 77 });
assert.strictEqual(old.version, 1, "B10 needs no schema bump");
assert.deepStrictEqual(old.records, [rec("a", 5)], "old records survive untouched");
assert.deepStrictEqual(old.sync, L.defaultState().sync, "missing sync block → defaults");
const junk = L.migrate({ version: 1, sync: { on: true, tested: false, pullSeq: -3, pushMark: "x", deviceId: 4, token: 9 } }).sync;
assert.deepStrictEqual([junk.on, junk.pullSeq, junk.pushMark, junk.deviceId, junk.token], [false, 0, 0, null, ""],
  "sync can't be on untested; a bad cursor or mark falls to 0 (re-sync, never skip)");

/* row round-trip: columns out, everything else through data */
const rx = { id: "rx-2026-01-02", kind: "rx", day: "2026-01-02", at: 3, updatedAt: 4, dilated: true,
             od: { sph: -1.25, cyl: 0, axis: null }, os: { sph: -1, cyl: -0.5, axis: 90 } };   // made up
const args = L.rowArgs(rx, "dev-A");
assert.deepStrictEqual(args.slice(0, 3), ["rx-2026-01-02", "rx", "2026-01-02"], "columns in upsert order");
assert.deepStrictEqual([args[4], args[5], args[6]], [4, null, "dev-A"], "updatedAt, no tombstone, deviceId");
const back = L.fromRow({ id: args[0], kind: args[1], day: args[2], data: args[3], updatedAt: args[4], deletedAt: args[5] });
assert.deepStrictEqual(back, rx, "record → row → record is lossless");
assert.ok(!("deviceId" in back), "deviceId stays a column, never lands in a local record");
const dead = L.fromRow({ id: "b", kind: "break", day: "2026-10-12", data: "{}", updatedAt: "9", deletedAt: "9" });
assert.deepStrictEqual([dead.updatedAt, dead.deletedAt], [9, 9], "string integers from the wire become numbers");
assert.strictEqual(L.fromRow({ id: "b", kind: "break", data: "{not json", updatedAt: 1 }), null, "bad data → skipped, no throw");
assert.strictEqual(L.fromRow({ id: "b", kind: "break", data: "{}", updatedAt: null }), null, "no updatedAt → skipped");
assert.strictEqual(L.fromRow({ id: "b", kind: "break", data: '{"id":"x","updatedAt":1}', updatedAt: 5 }).id, "b", "columns beat data");

/* Hrana encoding */
assert.deepStrictEqual(L.hranaArg(1760400000000), { type: "integer", value: "1760400000000" }, "ms timestamps as integer strings");
assert.deepStrictEqual(L.hranaArg(null), { type: "null" });
assert.deepStrictEqual(L.hranaArg("x"), { type: "text", value: "x" });
assert.strictEqual(L.hranaVal({ type: "integer", value: "42" }), 42);
assert.strictEqual(L.hranaVal({ type: "null" }), null);

/* URL */
assert.strictEqual(L.syncBase(" libsql://vis-me.turso.io/ "), "https://vis-me.turso.io", "libsql:// → https://");
assert.strictEqual(L.syncBase("http://127.0.0.1:8080"), "http://127.0.0.1:8080", "local server kept");
assert.strictEqual(L.syncBase("vis-me.turso.io"), null, "no scheme → refused, not guessed");
assert.strictEqual(L.syncBase(""), null);

/* merge: tombstones both ways, ties, never shrinks */
const live = rec("x", 10), tomb = rec("x", 20, { deletedAt: 20 });
assert.strictEqual(L.mergeRecords([live], [tomb]).records[0].deletedAt, 20, "newer tombstone beats older live");
assert.strictEqual(L.mergeRecords([tomb], [live]).records[0].deletedAt, 20, "older live does not resurrect");
const relive = rec("x", 30);
assert.ok(!L.mergeRecords([tomb], [relive]).records[0].deletedAt, "newer live beats older tombstone");
const tieTomb = rec("x", 10, { deletedAt: 10 });
assert.ok(L.mergeRecords([live], [tieTomb]).records[0].deletedAt, "tie: tombstone wins");
assert.ok(L.mergeRecords([tieTomb], [live]).records[0].deletedAt, "tie: tombstone wins from either side");
const full = [rec("a", 1), rec("b", 2), rec("c", 3)];
assert.deepStrictEqual(L.mergeRecords(full, []).records, full, "empty pull keeps every local record");
const m = L.mergeRecords([], full);
assert.deepStrictEqual([m.records.length, m.added], [3, 3], "empty device adopts the cloud");
assert.strictEqual(L.mergeRecords(full, [null, rec("d", 4)]).records.length, 4, "a skipped row is ignored, the rest merge");
const snap = full.slice();
L.mergeRecords(full, [rec("a", 99)]);
assert.deepStrictEqual(full, snap, "merge does not mutate its input");

/* pushSet: mark and margin */
assert.deepStrictEqual(L.pushSet([], 0), [], "empty device pushes nothing");
assert.strictEqual(L.pushSet(full, 0).length, 3, "never pushed → everything");
const T = 1e12, M = L.PUSH_MARGIN_MS;
const marked = [rec("old", T - M - 1), rec("edge", T - M), rec("new", T + 5)];
assert.deepStrictEqual(L.pushSet(marked, T).map(r => r.id), ["edge", "new"], "since the mark, less the margin");

/* The SQL itself, run on the sqlite node ships with. Two devices, one table. */
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec(L.SQL.create); db.exec(L.SQL.index); db.exec(L.SQL.create);   // create is safe to repeat
const up = db.prepare(L.SQL.upsert), pull = db.prepare(L.SQL.pull);
const push = (recs, dev) => recs.forEach(r => up.run(...L.rowArgs(r, dev)));
const pullAll = (cursor) => {
  const rows = pull.all(cursor);
  return { recs: rows.map(L.fromRow), cursor: rows.reduce((c, r) => Math.max(c, r.seq), cursor) };
};
const count = () => db.prepare("SELECT COUNT(*) n FROM records").get().n;

push([rec("w", 100)], "A");
push([rec("w", 50)], "B");
assert.strictEqual(L.fromRow(db.prepare("SELECT * FROM records").get()).updatedAt, 100, "SQL: older write loses");
push([rec("w", 100, { deletedAt: 100 })], "B");
assert.strictEqual(db.prepare("SELECT deletedAt d FROM records").get().d, 100, "SQL: tie → tombstone wins, as in beats()");
push([rec("w", 100)], "A");
assert.strictEqual(db.prepare("SELECT deletedAt d FROM records").get().d, 100, "SQL: tie live does not undo the tombstone");

/* A9: the laptop pulls at 12:00; the phone then pushes a walk logged offline at 10:00. */
let laptop = pullAll(0);
const h = 3600000, ten = T + 10 * h, twelve = T + 12 * h;
push([rec("lap", twelve)], "laptop");
laptop = pullAll(laptop.cursor);
push([rec("walk", ten, { kind: "outdoor" })], "phone");   // late push, early updatedAt
const after = pullAll(laptop.cursor);
assert.deepStrictEqual(after.recs.map(r => r.id), ["walk"], "seq cursor pulls a late push an updatedAt cursor would miss");
assert.strictEqual(pullAll(after.cursor).recs.length, 0, "cursor at the end: nothing more");
const noop = db.prepare("SELECT seq FROM records WHERE id='walk'").get().seq;
push([rec("walk", ten, { kind: "outdoor" })], "phone");
assert.strictEqual(db.prepare("SELECT seq FROM records WHERE id='walk'").get().seq, noop, "a re-push that loses moves no cursor");

/* An empty device joins: pulls everything, pushes nothing, cloud unchanged. */
const before = count();
const fresh = pullAll(0);
assert.strictEqual(fresh.recs.length, before, "new device pulls every row");
push(L.pushSet([], 0), "C");
assert.strictEqual(count(), before, "empty device never shrinks or overwrites the cloud");
}

/* ---- export: backup, restore, CSV (B11) ---- */
{
  const st = L.defaultState();
  st.sync.token = "SECRET-TOKEN"; st.sync.url = "libsql://x"; st.outdoorRun = 123456;
  st.settings.theme = "dark"; st.settings.breaks.enabled = true;
  st.records = [
    { id: "b1", kind: "break", day: "2026-10-13", at: new Date(2026, 9, 13, 9, 5, 7).getTime(), updatedAt: 1 },
    { id: "b2", kind: "break", day: "2026-10-12", at: new Date(2026, 9, 12, 22, 0, 0).getTime(), updatedAt: 2 },
    { id: "bx", kind: "break", day: "2026-10-12", at: 5, updatedAt: 9, deletedAt: 9 },
    { id: "o1", kind: "outdoor", source: "timed", day: "2026-10-13", seconds: 1800, at: 3, updatedAt: 3 },
    { id: "o2", kind: "outdoor", source: "quick", day: "2026-10-13", seconds: 900, at: 4, updatedAt: 4 },
    { id: "checkin-2026-10-13", kind: "checkin", day: "2026-10-13", scores: { dryness: 1, headache: 0, blur: 2 }, updatedAt: 5 },
    { id: "rx-2026-09-01", kind: "rx", day: "2026-09-01", at: 6, updatedAt: 6, dilated: true,
      od: { sph: -3.25, cyl: -0.5, axis: 90 }, os: { sph: -3.5, cyl: 0, axis: null } }
  ];
  const text = JSON.stringify(L.makeBackup(st, 1000));
  assert.ok(!/SECRET-TOKEN|libsql|123456|outdoorRun/.test(text), "backup leaves out the token, url and running timer");

  const back = L.parseBackup(text);
  assert.ok(!back.error, "own backup parses");
  assert.deepStrictEqual(back.records, st.records, "records round-trip exactly, tombstone included");
  assert.strictEqual(back.skipped, 0);

  /* restore = merge: into an empty device it adds all, into the same device it changes nothing */
  const empty = L.mergeRecords([], back.records);
  assert.strictEqual(empty.added, st.records.length, "empty device gets every record");
  const again = L.mergeRecords(st.records, back.records);
  assert.strictEqual(again.added + again.replaced, 0, "restoring onto the same data is a no-op");
  const newer = st.records.map(r => r.id === "b1" ? Object.assign({}, r, { updatedAt: 50 }) : r);
  assert.strictEqual(L.mergeRecords(newer, back.records).records.find(r => r.id === "b1").updatedAt, 50, "an older backup never overwrites a newer local record");

  /* bad input is refused or counted, never throws, never partially applies */
  assert.ok(L.parseBackup("not json").error, "garbage text refused");
  assert.ok(L.parseBackup("[1,2]").error, "array refused");
  assert.ok(L.parseBackup(JSON.stringify({ format: "other", version: 1, records: [] })).error, "wrong format refused");
  assert.ok(/newer/.test(L.parseBackup(JSON.stringify({ format: L.BACKUP_FORMAT, version: L.SCHEMA_VERSION + 1, records: [] })).error), "newer schema refused");
  assert.ok(L.parseBackup(JSON.stringify({ format: L.BACKUP_FORMAT, records: [] })).error, "missing version refused");
  const messy = L.parseBackup(JSON.stringify({ format: L.BACKUP_FORMAT, version: 1, settings: { theme: "neon" },
    records: [st.records[0], null, { id: "", kind: "break", day: "2026-10-13", updatedAt: 1 }, { id: "z", kind: "break", day: "yesterday", updatedAt: 1 }, { id: "w", kind: "break", day: "2026-10-13" }] }));
  assert.strictEqual(messy.records.length, 1, "only the usable record loads");
  assert.strictEqual(messy.skipped, 4, "the four unusable ones are counted");
  assert.strictEqual(messy.settings.theme, "system", "bad setting healed");

  /* settings restore keeps this device's two on-switches */
  const cur = L.defaultState().settings; cur.breaks.enabled = true; cur.checkin.nudge = false;
  const inc = L.defaultState().settings; inc.theme = "light"; inc.breaks.enabled = false; inc.checkin.nudge = true; inc.dayStartHour = 3;
  const rs = L.restoreSettings(cur, inc);
  assert.strictEqual(rs.theme, "light", "theme restored");
  assert.strictEqual(rs.dayStartHour, 3, "rollover restored");
  assert.strictEqual(rs.breaks.enabled, true, "this device's reminder switch kept");
  assert.strictEqual(rs.checkin.nudge, false, "this device's nudge switch kept");

  /* CSV */
  const lines = (w) => L.toCsv(w, st.records).split("\r\n");
  assert.deepStrictEqual(lines("breaks"), ["day,time", "2026-10-12,22:00:00", "2026-10-13,09:05:07", ""], "breaks sorted, tombstone left out");
  assert.deepStrictEqual(lines("outdoor"), ["day,seconds,minutes,source,estimate", "2026-10-13,1800,30,timed,no", "2026-10-13,900,15,quick,yes", ""], "quick entries marked as estimates");
  assert.deepStrictEqual(lines("symptoms"), ["day,dryness,headache,blur", "2026-10-13,1,0,2", ""], "a 0 score stays 0, not blank");
  assert.deepStrictEqual(lines("rx"), ["day,od_sph,od_cyl,od_axis,od_se,os_sph,os_cyl,os_axis,os_se,dilated", "2026-09-01,-3.25,-0.5,90,-3.5,-3.5,0,,-3.5,yes", ""], "rx with spherical equivalent");
  assert.strictEqual(L.toCsv("rx", []), "day,od_sph,od_cyl,od_axis,od_se,os_sph,os_cyl,os_axis,os_se,dilated\r\n", "no records: header only");
}

console.log("check-logic: all asserts passed");
