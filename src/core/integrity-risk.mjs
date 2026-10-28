/**
 * Integrity risk for one exam sitting, from the counters and time-away record
 * the exam session keeps (api/quiz-session.mjs). Pure, so the admin list, the
 * integrity trail, the report and the assessor's screen all show the same
 * verdict.
 *
 * The level is a prompt for a human, never an automatic penalty: browsers
 * report focus changes for innocent reasons (a notification, a password
 * manager, a slow microphone prompt), so one stray event must not flag a
 * candidate, while a pattern of them, long absences, a second device or
 * developer tools should.
 */
export const RISK_LEVELS = { low: 'Low', review: 'Review', high: 'High' };

const MINUTE = 60_000;
const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
};

/**
 * Weighted signals. `free` events are ignored before they count, so the
 * ordinary noise of one exam (entering full screen late, one accidental
 * right-click) does not move the level.
 */
const SIGNALS = [
  { keys: ['tab_switch', 'visibility'], weight: 2, free: 1, label: (n) => `${n} tab switch${n === 1 ? '' : 'es'}` },
  { keys: ['window_blur', 'blur'], weight: 1, free: 3, label: (n) => `${n} times the exam window lost focus` },
  { keys: ['multi_window'], weight: 5, free: 0, label: (n) => `${n} second window${n === 1 ? '' : 's'} on the same exam` },
  { keys: ['device_switch'], weight: 5, free: 0, label: (n) => `moved to another device ${n} time${n === 1 ? '' : 's'}` },
  { keys: ['ip_change'], weight: 2, free: 0, label: (n) => `network address changed ${n} time${n === 1 ? '' : 's'}` },
  { keys: ['devtools_key', 'devtools_resize'], weight: 3, free: 0, label: (n) => `${n} developer-tools attempt${n === 1 ? '' : 's'}` },
  { keys: ['paste', 'paste_attempt'], weight: 2, free: 0, label: (n) => `${n} paste attempt${n === 1 ? '' : 's'}` },
  { keys: ['copy', 'copy_attempt', 'cut_attempt'], weight: 1, free: 1, label: (n) => `${n} copy attempt${n === 1 ? '' : 's'}` },
  { keys: ['screenshot'], weight: 3, free: 0, label: (n) => `${n} screenshot key press${n === 1 ? '' : 'es'}` },
  { keys: ['fullscreen_exit'], weight: 1, free: 1, label: (n) => `left full screen ${n} time${n === 1 ? '' : 's'}` },
  { keys: ['browser_close', 'exam_exit'], weight: 1, free: 1, label: (n) => `left the exam page ${n} time${n === 1 ? '' : 's'}` },
];

export function integrityRisk(quizState) {
  const counters = quizState?.integrity && typeof quizState.integrity === 'object' ? quizState.integrity : {};
  const away = quizState?.away && typeof quizState.away === 'object' ? quizState.away : {};
  const count = (keys) => keys.reduce((n, k) => n + (Number.isFinite(Number(counters[k])) ? Number(counters[k]) : 0), 0);
  let score = 0;
  const reasons = [];
  for (const s of SIGNALS) {
    const n = count(s.keys);
    const scored = Math.max(0, n - s.free) * s.weight;
    if (scored > 0) { score += scored; reasons.push({ points: scored, text: s.label(n) }); }
  }
  const totalAway = Math.max(0, Number(away.total_ms) || 0);
  const longestAway = Math.max(0, Number(away.longest_ms) || 0);
  if (totalAway >= 5 * MINUTE) { score += 6; reasons.push({ points: 6, text: `${fmtDuration(totalAway)} away from the exam in total` }); }
  else if (totalAway >= MINUTE) { score += 3; reasons.push({ points: 3, text: `${fmtDuration(totalAway)} away from the exam in total` }); }
  if (longestAway >= 2 * MINUTE) { score += 3; reasons.push({ points: 3, text: `longest absence ${fmtDuration(longestAway)}` }); }
  if (away.since) { score += 2; reasons.push({ points: 2, text: 'left the exam and had not returned when it ended' }); }
  const level = score >= 10 ? 'high' : score >= 4 ? 'review' : 'low';
  return {
    level,
    label: RISK_LEVELS[level],
    score,
    reasons: reasons.sort((a, b) => b.points - a.points).map((r) => r.text),
    away_ms: totalAway,
    longest_away_ms: longestAway,
    away_count: Math.max(0, Number(away.count) || 0),
  };
}
