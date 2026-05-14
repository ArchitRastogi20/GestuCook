// frontend/static/js/app.js
// Thin bootstrap. Imports state, screens, mounts the active screen.

import { state } from "./state.js";
import { api } from "./api.js";
import { mountDiag } from "./ui/diag.js";

import * as welcome from "./screens/welcome.js";
import * as mode    from "./screens/mode.js";
import * as photo   from "./screens/photo.js";
import * as handsfree from "./screens/handsfree.js";
import * as recipes from "./screens/recipes.js";
import * as cooking  from "./screens/cooking.js";
import * as epilogue from "./screens/epilogue.js";
import * as ambient  from "./screens/ambient.js";

const SCREENS = { welcome, mode, photo, handsfree, recipes, cooking, epilogue, ambient };

const root = document.querySelector("#screen-root");
let current = null;

state.on("screen", async (name) => {
  if (current?.unmount) current.unmount();
  current = SCREENS[name];
  await current.mount(root);
});

// initial screen: if user already exists in localStorage, skip welcome
if (state.user) state.go("welcome");  // still show "welcome back" UX
else            state.go("welcome");

// cost counter
state.on("cost", (c) => {
  const el = document.querySelector("#cost-display");
  if (!el) return;
  el.innerHTML = `<b>$${c.usd.toFixed(4)}</b> · ${c.in} in / ${c.out} out`;
});

// provider badge
api.costSnapshot().then(snap => {
  const el = document.querySelector("#provider-badge");
  if (!el) return;
  el.textContent = `${snap.provider || ""} · ${snap.model || ""}`.trim();
}).catch(() => {});

// service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

// diagnostics overlay
mountDiag();
