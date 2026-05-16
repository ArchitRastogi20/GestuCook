// frontend/static/js/ui/diag.js
// Alt+D toggles a debug overlay:
//   - live per-frame engine state (fps, hand, pose, hold %, armed)
//   - the command arbiter log (which modality triggered which action)
//   - the last gesture fires
// This is the evidence panel: if the app misbehaves, this shows exactly why.

import { GestureEngine } from "../gestures.js";
import { commands } from "../commands.js";

let overlay = null;

function render() {
  if (!overlay) return;

  const f = GestureEngine.getLastFrame();
  const live = [
    `fps     ${String(f.fps).padStart(3)}`,
    `hand    ${f.hasHand ? "yes" : "no"}`,
    `pose    ${f.label}`,
    `holding ${f.cand ? f.cand : "--"}  ${Math.round((f.fill || 0) * 100)}%`,
    `canned  ${f.canned || "-"}`,
    `armed   ${f.needRelease ? "no — release hand" : "yes"}`,
  ].join("\n");

  const cmds = commands.getLog().slice(-12).reverse().map(c => {
    const t = new Date(c.ts).toLocaleTimeString();
    return `${t}  ${c.source.padEnd(7)} ${c.action.padEnd(8)} ${c.accepted ? "✓" : "· dropped"}`;
  }).join("\n");

  const fires = GestureEngine.getDiagnostics().slice(-8).reverse().map(r => {
    const t = new Date(r.ts).toLocaleTimeString();
    return `${t}  ${r.source.padEnd(6)} ${r.class}`;
  }).join("\n");

  overlay.innerHTML =
    `<b>live (Alt+D)</b><pre style="margin:6px 0">${live}</pre>` +
    `<b>commands</b><pre style="margin:6px 0">${cmds || "—"}</pre>` +
    `<b>gesture fires</b><pre style="margin:6px 0">${fires || "—"}</pre>`;
}

export function mountDiag(root = document.body) {
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "d") {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.style.cssText = `
          position: fixed; right: 12px; top: 80px; z-index: 200;
          width: 300px; max-height: 70vh; overflow:auto;
          background: var(--paper); border: 1px solid var(--hairline);
          border-radius: 12px; padding: 12px;
          font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap;
          box-shadow: var(--shadow-soft);
        `;
        root.appendChild(overlay);
      } else { overlay.remove(); overlay = null; }
    }
  });
  setInterval(render, 250);
}
