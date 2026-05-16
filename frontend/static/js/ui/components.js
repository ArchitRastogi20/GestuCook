// frontend/static/js/ui/components.js
import { svg, ICONS } from "./icons.js";
import { magnetic } from "./motion.js";

function el(tag, opts = {}, children = []) {
  const n = document.createElement(tag);
  if (opts.cls) n.className = opts.cls;
  if (opts.html) n.innerHTML = opts.html;
  if (opts.text) n.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, v);
  if (opts.style) for (const [k, v] of Object.entries(opts.style)) n.style[k] = v;
  for (const c of children) if (c) n.appendChild(c);
  return n;
}

export function Bezel({ size = "lg", lift = false, children = [] } = {}) {
  const core = el("div", { cls: "core" }, children);
  const cls = ["bezel", size === "sm" ? "sm" : "", lift ? "lift" : ""].filter(Boolean).join(" ");
  return el("div", { cls }, [core]);
}

export function Capsule({ position = "top", items = [] } = {}) {
  const cls = position === "top" ? "capsule capsule--top" : "capsule capsule--hud hud";
  return el("nav", { cls }, items);
}

export function Button({ label, intent = "primary", trailingIcon = null, onClick } = {}) {
  const cls = intent === "ghost" ? "btn btn--ghost" : "btn";
  const kids = [el("span", { text: label })];
  if (trailingIcon && ICONS[trailingIcon]) {
    const nest = el("span", { cls: "nest" }, [svg(ICONS[trailingIcon], { size: 14 })]);
    kids.push(nest);
  }
  const b = el("button", { cls, attrs: { type: "button" } }, kids);
  if (onClick) b.addEventListener("click", onClick);
  magnetic(b);
  return b;
}

// Toggle a button into a loading state: relabel it, disable it, mark it.
// Prevents double-submits and gives the user feedback during slow API calls.
export function setLoading(btn, on, label) {
  if (!btn) return;
  const span = btn.querySelector("span");
  if (on) {
    if (span && !btn.dataset.label) btn.dataset.label = span.textContent;
    if (span && label) span.textContent = label;
    btn.disabled = true;
    btn.classList.add("is-loading");
  } else {
    if (span && btn.dataset.label) span.textContent = btn.dataset.label;
    delete btn.dataset.label;
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

export function Eyebrow({ text = "" } = {}) {
  return el("div", { cls: "eyebrow" }, [
    el("span", { cls: "dot" }),
    el("span", { text })
  ]);
}

export function Chip({ label = "", variant = "default" } = {}) {
  const cls = variant === "copper" ? "chip chip--copper"
            : variant === "sage"   ? "chip chip--sage"
            : "chip";
  return el("span", { cls, text: label });
}

export function PipFrame({ video, canvas, status = "tracking", confidence = 0 } = {}) {
  const frame = el("div", { cls: "frame" });
  if (video) frame.appendChild(video);
  if (canvas) frame.appendChild(canvas);
  const label = el("div", { cls: "label" }, [
    el("span", { cls: "live", text: status }),
    el("span", { text: confidence.toFixed(2) })
  ]);
  return el("div", { cls: "pip" }, [frame, label]);
}

const HUD_PILLS = [
  { key: "swipe_left",  label: "swipe ←" },
  { key: "swipe_right", label: "swipe →" },
  { key: "thumbs_up",   label: "thumbs up" },
  { key: "fist",        label: "fist" },
  { key: "open_palm",   label: "open palm" },
];

export function Hud({ status = "tracking", active = null, timer = null, locked = false } = {}) {
  const statusEl = el("span", { cls: "status", text: status });
  const sep = el("span", { cls: "sep" });
  const pills = el("div", { cls: "gest-pills" });
  for (const p of HUD_PILLS) {
    const cls = "gp" + (p.key === active ? " on" : "");
    pills.appendChild(el("span", { cls, text: p.label, attrs: { "data-gesture": p.key } }));
  }
  const items = [statusEl, sep, pills];
  if (timer != null) items.push(el("span", { cls: "sep" }), el("span", { cls: "timer", text: timer }));
  if (locked) items.push(el("span", { cls: "sep" }), el("span", { cls: "lock", text: "LOCKED" }));
  return Capsule({ position: "bottom", items });
}

export function highlightHudGesture(hud, gesture) {
  if (!hud) return;
  for (const p of hud.querySelectorAll(".gp")) p.classList.remove("on");
  if (gesture) hud.querySelector(`[data-gesture="${gesture}"]`)?.classList.add("on");
}

export function Cascade({ items = [], focusedIndex = 0 } = {}) {
  const wrap = el("div", { cls: "cascade" });
  const prev = items[focusedIndex - 1];
  const next = items[focusedIndex + 1];

  function peekCore(it) {
    const num = el("div", { cls: "t-eyebrow", text: it.num, style: { color: "var(--ink-3)" } });
    const h = el("h3", { cls: "t-display-m", html: it.title });
    const foot = el("div", { cls: "footer", style: { marginTop: "12px", display: "flex", gap: "8px" } });
    for (const f of it.footer || []) foot.appendChild(el("span", { cls: "chip", text: f }));
    return el("div", { cls: "core-sm" }, [num, h, foot]);
  }

  if (next) wrap.appendChild(el("div", { cls: "peek next" }, [peekCore(next)]));
  if (prev) wrap.appendChild(el("div", { cls: "peek prev" }, [peekCore(prev)]));
  return wrap;
}
