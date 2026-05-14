// frontend/static/js/scheduler.js
// Interleaves two recipes' steps by ETA from feature 1's `duration_seconds`.

export function buildSchedule(recipeA, recipeB) {
  // Pair: while A has a long-running step, slot B's quick steps in.
  const a = (recipeA.steps || []).map((s, i) => ({ recipe: "A", idx: i, text: stepText(s), dur: stepDur(s) }));
  const b = (recipeB.steps || []).map((s, i) => ({ recipe: "B", idx: i, text: stepText(s), dur: stepDur(s) }));
  const schedule = [];
  let ai = 0, bi = 0;
  while (ai < a.length || bi < b.length) {
    const cur = (a[ai]?.dur || 0) >= (b[bi]?.dur || 0) ? a[ai] : b[bi];
    schedule.push(cur);
    if (cur === a[ai]) ai++; else bi++;
  }
  return schedule;
}
function stepText(s) { return typeof s === "string" ? s : (s.text || ""); }
function stepDur(s)  { return typeof s === "object" ? (s.duration_seconds || 0) : 0; }
