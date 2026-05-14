// frontend/static/js/scheduler.js
// Interleaves two recipes' steps by cumulative elapsed time.
// Each recipe has a running clock. We advance whichever recipe's clock is currently behind.
// Steps with no duration count as 0 seconds for scheduling but still appear.

export function buildSchedule(recipeA, recipeB) {
  const a = (recipeA.steps || []).map((s, i) => ({ recipe: "A", idx: i, text: stepText(s), dur: stepDur(s) }));
  const b = (recipeB.steps || []).map((s, i) => ({ recipe: "B", idx: i, text: stepText(s), dur: stepDur(s) }));
  const schedule = [];
  let ai = 0, bi = 0;
  let ta = 0, tb = 0;       // elapsed seconds on each recipe's clock
  while (ai < a.length || bi < b.length) {
    if (ai >= a.length)      { schedule.push(b[bi]); tb += b[bi].dur || 0; bi++; }
    else if (bi >= b.length) { schedule.push(a[ai]); ta += a[ai].dur || 0; ai++; }
    else if (ta <= tb)       { schedule.push(a[ai]); ta += a[ai].dur || 0; ai++; }
    else                     { schedule.push(b[bi]); tb += b[bi].dur || 0; bi++; }
  }
  return schedule;
}
function stepText(s) { return typeof s === "string" ? s : (s.text || ""); }
function stepDur(s)  { return typeof s === "object" ? (s.duration_seconds || 0) : 0; }
