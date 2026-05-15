// frontend/static/js/ui/diag.js
// Alt+D toggles a small overlay listing the last 50 gesture fires.

import { GestureEngine } from "../gestures.js";

let overlay = null;

function render() {
  if (!overlay) return;
  const rows = GestureEngine.getDiagnostics().reverse().map(r => {
    const t = new Date(r.ts).toLocaleTimeString();
    return `<div>${t}  ${r.source.padEnd(6)} ${r.class.padEnd(12)} ${(r.score || 0).toFixed(2)}</div>`;
  }).join("");
  overlay.innerHTML = `<b>gestures (Alt+D)</b><div style="margin-top:6px">${rows || "—"}</div>`;
}

export function mountDiag(root = document.body) {
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "d") {
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.style.cssText = `
          position: fixed; right: 12px; top: 80px; z-index: 200;
          width: 280px; max-height: 60vh; overflow:auto;
          background: var(--paper); border: 1px solid var(--hairline);
          border-radius: 12px; padding: 12px;
          font-family: var(--font-mono); font-size: 11px;
          box-shadow: var(--shadow-soft);
        `;
        root.appendChild(overlay);
      } else { overlay.remove(); overlay = null; }
    }
  });
  setInterval(render, 500);
}
