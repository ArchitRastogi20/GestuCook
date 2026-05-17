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
import * as trainer  from "./screens/trainer.js";

const SCREENS = { welcome, mode, photo, handsfree, recipes, cooking, epilogue, ambient, trainer };

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

// provider badge -- retried through the backend's startup window. The backend
// container needs a few seconds to accept connections; without this the first
// /api/config call 502s and the badge is stuck on "loading" forever.
(async function loadProviderBadge() {
  const el = document.querySelector("#provider-badge");
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const snap = await api.costSnapshot();
      if (el) el.textContent = `${snap.provider || ""} · ${snap.model || ""}`.trim();
      return;
    } catch {
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  if (el) el.textContent = "offline";
})();

// service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});
}

// diagnostics overlay
mountDiag();
