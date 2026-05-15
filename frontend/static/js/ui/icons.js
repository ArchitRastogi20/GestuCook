// frontend/static/js/ui/icons.js
// Minimal Phosphor-light-style line icons, stroke 1.4.

export function svg(d, { size = 16, stroke = 1.4 } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", size);
  el.setAttribute("height", size);
  el.setAttribute("fill", "none");
  el.setAttribute("stroke-width", stroke);
  el.setAttribute("stroke", "currentColor");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  el.appendChild(path);
  return el;
}

export const ICONS = {
  arrowRight:  "M5 12h14M13 6l6 6-6 6",
  arrowLeft:   "M19 12H5M11 18l-6-6 6-6",
  plus:        "M12 5v14M5 12h14",
  mic:         "M12 3a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zM5 11a7 7 0 0 0 14 0M12 18v3",
  camera:      "M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  play:        "M6 5v14l13-7z",
  pause:       "M7 5h3v14H7zM14 5h3v14h-3z",
  check:       "M5 12l5 5L20 6"
};
