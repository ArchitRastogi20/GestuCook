// frontend/static/js/screens/recipes.js
import { Bezel, Eyebrow, Chip, Button, PipFrame, Hud, Cascade } from "../ui/components.js";
import { state } from "../state.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";

let videoEl, canvasEl;

export async function mount(root) {
  root.innerHTML = "";
  if (!state.recipes.length) { state.go("mode"); return; }

  const i = state.recipe_index;
  const total = state.recipes.length;
  const r = state.recipes[i];

  const eyebrow = Eyebrow({ text: `recipe ${String(i+1).padStart(2,"0")} of ${String(total).padStart(2,"0")}` });

  const h1 = document.createElement("h1");
  h1.className = "t-display-xl";
  h1.style.maxWidth = "16ch";
  h1.innerHTML = `A weeknight <span class="italic">${(r.cuisine || "dish")}</span>.`;

  const lede = document.createElement("p");
  lede.className = "t-body";
  lede.style.marginTop = "var(--space-4)";
  lede.innerHTML = `${(r.description || "Simple, hands-busy cooking.")} <b>Swipe right for next, thumbs up to start cooking.</b>`;

  // featured card
  const meta = document.createElement("div");
  meta.className = "recipe-meta";
  if (r.cuisine) meta.append(Chip({ label: r.cuisine, variant: "copper" }));
  if (r.time)    meta.append(Chip({ label: r.time }));
  if (r.servings) meta.append(Chip({ label: `${r.servings} servings` }));

  const title = document.createElement("h2");
  title.className = "recipe-title t-display-l";
  title.textContent = r.name;

  const desc = document.createElement("p");
  desc.className = "recipe-desc";
  desc.textContent = r.long_description || r.description || "";

  const ing = document.createElement("div");
  ing.className = "ingredients-grid";
  (r.ingredients || []).forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "ingredients-row";
    row.innerHTML = `<span class="num">${String(idx+1).padStart(2,"0")}</span><span class="name">${it.name || it}</span><span class="qty">${it.qty || ""}</span>`;
    ing.append(row);
  });

  const cta = document.createElement("div");
  cta.className = "recipes-cta";
  cta.append(
    Button({ label: "Start cooking", trailingIcon: "arrowRight", onClick: () => state.go("cooking") }),
    Button({ label: "Read aloud",   intent: "ghost", onClick: () => import("../audio.js").then(m => new m.TTSQueue().enqueue(r.name + ". " + (r.description || ""))) }),
  );
  const trainBtn = Button({ label: "Practice gestures", intent: "ghost", onClick: () => state.go("trainer") });
  cta.append(trainBtn);

  const featured = Bezel({ children: [meta, title, desc, ing, cta] });

  // cascade right column
  const cascadeItems = state.recipes.map((rr, idx) => ({
    num: `recipe ${String(idx+1).padStart(2,"0")}`,
    title: `${rr.name}`,
    footer: [rr.cuisine, rr.time, rr.servings ? `${rr.servings} servings` : null].filter(Boolean),
  }));
  const cascade = Cascade({ items: cascadeItems, focusedIndex: i });

  // webcam pip
  videoEl  = document.createElement("video"); videoEl.playsInline = true; videoEl.autoplay = true; videoEl.muted = true;
  canvasEl = document.createElement("canvas"); canvasEl.width = 320; canvasEl.height = 240;
  const pip = PipFrame({ video: videoEl, canvas: canvasEl, status: "tracking", confidence: 0 });

  const rightCol = document.createElement("div");
  rightCol.append(cascade, pip);

  const stage = document.createElement("div");
  stage.className = "recipes-stage";
  stage.append(featured, rightCol);

  const hud = Hud({ status: "tracking", active: null });

  const wrap = document.createElement("div");
  wrap.append(eyebrow, h1, lede, stage);
  root.append(wrap, hud);
  enter(wrap);

  // wire gestures
  let pickA = null, pickB = null;
  await GestureEngine.init(videoEl, canvasEl, (g) => onGesture(g));
  GestureEngine.start();

  function onGesture(g) {
    // active pill highlight
    for (const p of hud.querySelectorAll(".gp")) p.classList.remove("on");
    const pill = hud.querySelector(`[data-gesture="${g}"]`);
    if (pill) pill.classList.add("on");

    if (g === "swipe_right") next();
    if (g === "swipe_left")  prev();

    if (g === "victory") {
      if (pickA == null) {
        pickA = state.recipe_index;
        import("../audio.js").then(m => new m.TTSQueue().enqueue(`Selected ${state.recipes[pickA].name}. Swipe to pick a second.`));
        return;
      } else if (pickA !== state.recipe_index && pickB == null) {
        pickB = state.recipe_index;
        import("../audio.js").then(m => new m.TTSQueue().enqueue(`Selected ${state.recipes[pickB].name}. Thumbs up to start cooking both.`));
        return;
      }
    }

    if (g === "thumbs_up") {
      if (pickA != null && pickB != null && pickA !== pickB) {
        state.mode = "parallel-2";
        state._parallelA = pickA; state._parallelB = pickB;
        state.go("cooking");
        return;
      }
      state.go("cooking");
    }

    if (g === "fist")        state.go("mode");
  }
  function next() { state.recipe_index = Math.min(total - 1, state.recipe_index + 1); mount(root); }
  function prev() { state.recipe_index = Math.max(0, state.recipe_index - 1); mount(root); }
}

export function unmount() {
  GestureEngine.stop();
}
