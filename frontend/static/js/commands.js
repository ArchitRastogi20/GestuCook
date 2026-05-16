// frontend/static/js/commands.js
// Single input arbiter for GestuCook.
//
// The problem it solves: gestures, the voice loop, timers and buttons all used
// to mutate state independently, so one intent ("next step") could fire twice
// -- once from a gesture and once from the voice loop hearing the same moment
// -- and the app would skip a step. Now EVERY input routes through dispatch():
// one global cooldown, one source of truth, and a log so we can see exactly
// which modality triggered what (visible in the Alt+D overlay).

const COOLDOWN_MS = 1200;   // ignore non-button inputs this soon after the last accepted one

let handler = null;         // the active screen's action handler
let lastAt = -1e7;
const log = [];             // recent dispatches, newest last

export const commands = {
  // A screen registers its handler on mount, and clears it on unmount.
  bind(fn) { handler = fn || null; lastAt = -1e7; },
  unbind() { handler = null; },

  // Every input calls this. source: "gesture" | "voice" | "button" | "timer".
  // Buttons are explicit, so they always pass; other sources are debounced
  // globally so two modalities can't double-trigger one intent.
  dispatch(action, source = "gesture") {
    const now = performance.now();
    const forced = source === "button";
    const accepted = !!handler && (forced || now - lastAt >= COOLDOWN_MS);

    log.push({ ts: Date.now(), action, source, accepted });
    if (log.length > 60) log.shift();

    if (!accepted) return false;
    lastAt = now;
    handler(action, source);
    return true;
  },

  getLog() { return log.slice(); },
};
