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

// Request-status confirmation. A stroke-drawn ring + checkmark animates in the
// moment a request is fired ("sent"), then carries the working sub-text, then
// flips to a cross on failure. Returns the element plus a tiny controller.
export function RequestStatus() {
  const root = el("div", { cls: "req-status", attrs: { role: "status", "aria-live": "polite" } });
  root.innerHTML = `
    <svg class="req-glyph" viewBox="0 0 28 28" aria-hidden="true">
      <circle class="req-ring-bg" cx="14" cy="14" r="10"></circle>
      <circle class="req-ring" cx="14" cy="14" r="10" transform="rotate(-90 14 14)"
              stroke-dasharray="63" stroke-dashoffset="63"></circle>
      <path class="req-tick" d="M8.8 14.4 l3.4 3.4 L19.6 9.8"
            stroke-dasharray="17" stroke-dashoffset="17"></path>
      <path class="req-cross" d="M10 10 L18 18 M18 10 L10 18"></path>
    </svg>
    <span class="req-text">
      <span class="req-title"></span>
      <span class="req-sub"></span>
      <span class="req-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </span>`;
  const title = root.querySelector(".req-title");
  const sub   = root.querySelector(".req-sub");
  return {
    el: root,
    // request fired -- play the checkmark draw-in
    send(t = "Request sent", s = "") {
      root.classList.remove("error", "sent");
      root.style.display = "flex";
      void root.offsetWidth;                       // restart the draw animation
      root.classList.add("show", "sent", "working");
      title.textContent = t; sub.textContent = s;
    },
    update(s) { sub.textContent = s; },            // advance the working sub-text
    fail(t = "Something went wrong", s = "") {
      root.style.display = "flex";
      root.classList.remove("working");
      root.classList.add("show", "error");
      title.textContent = t; sub.textContent = s;
    },
  };
}

export function Eyebrow({ text = "" } = {}) {
  return el("div", { cls: "eyebrow" }, [
    el("span", { cls: "dot" }),
    el("span", { text })
  ]);
}

// A header row pairing a section label (left) with a navigation control (right).
export function ScreenHeader(left, right) {
  return el("div", { cls: "screen-header" }, [left, right]);
}

// A labelled on/off switch. onChange(checked) fires on each toggle.
export function Toggle({ label = "", checked = false, onChange } = {}) {
  const knob  = el("span", { cls: "toggle-knob" });
  const track = el("span", { cls: "toggle" + (checked ? " on" : "") }, [knob]);
  const field = el("button", {
    cls: "toggle-field",
    attrs: { type: "button", role: "switch", "aria-checked": String(checked) },
  }, [el("span", { cls: "toggle-label", text: label }), track]);
  let on = checked;
  field.addEventListener("click", () => {
    on = !on;
    track.classList.toggle("on", on);
    field.setAttribute("aria-checked", String(on));
    onChange && onChange(on);
  });
  return field;
}

export function Chip({ label = "", variant = "default" } = {}) {
  const cls = variant === "copper" ? "chip chip--copper"
            : variant === "sage"   ? "chip chip--sage"
            : "chip";
  return el("span", { cls, text: label });
}

// A plain shimmering placeholder block. Size it via the opts.
export function Skeleton({ width = "100%", height = "1em", radius = "" } = {}) {
  const s = el("div", { cls: "skeleton" });
  s.style.width = width;
  s.style.height = height;
  if (radius) s.style.borderRadius = radius;
  return s;
}

export function PipFrame({ video, canvas, status = "tracking", confidence = 0 } = {}) {
  const frame = el("div", { cls: "frame" });
  if (video) frame.appendChild(video);
  if (canvas) frame.appendChild(canvas);

  // Skeleton shimmer until the camera stream is actually playing -- the webcam
  // takes ~1s to start, and a black tile reads as "broken".
  frame.appendChild(el("div", { cls: "pip-skeleton" }, [el("div", { cls: "pip-skeleton-icon" })]));
  if (video) {
    const live = () => frame.classList.add("pip-live");
    if (video.readyState >= 3 && !video.paused) live();   // already streaming (re-render)
    video.addEventListener("playing", live);
    video.addEventListener("loadeddata", () => { if (!video.paused) live(); });
  }

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
