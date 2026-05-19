// frontend/static/js/screens/recipes.js
// Browse generated recipes. mount() starts the camera once; changing recipe
// re-renders the page but REUSES the same <video>/<canvas>, so the webcam
// stream is never interrupted. All input routes through the command arbiter.
import { Bezel, Eyebrow, Chip, Button, PipFrame, Hud, Cascade, ScreenHeader, Toggle, highlightHudGesture } from "../ui/components.js";
import { state } from "../state.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";
import { tts } from "../audio.js";
import { commands } from "../commands.js";

const GESTURE_ACTION = {
  swipe_right: "next", swipe_left: "back",
  thumbs_up: "cook", fist: "exit", victory: "pick",
};

export async function mount(root) {
  root.innerHTML = "";
  if (!state.recipes.length) { state.go("mode"); return; }

  // persistent webcam elements -- survive every re-render
  const videoEl  = document.createElement("video");
  videoEl.playsInline = true; videoEl.autoplay = true; videoEl.muted = true;
  const canvasEl = document.createElement("canvas");
  canvasEl.width = 320; canvasEl.height = 240;

  let pickA = null, pickB = null;

  function renderRecipe() {
    const i = state.recipe_index;
    const total = state.recipes.length;
    const r = state.recipes[i];

    const eyebrow = Eyebrow({ text: `recipe ${String(i + 1).padStart(2, "0")} of ${String(total).padStart(2, "0")}` });

    const h1 = document.createElement("h1");
    h1.className = "t-display-xl";
    h1.style.maxWidth = "16ch";
    h1.innerHTML = `A weeknight <span class="italic">${r.cuisine || "dish"}</span>.`;

    const lede = document.createElement("p");
    lede.className = "t-body";
    lede.style.marginTop = "var(--space-4)";
    lede.innerHTML = `${r.description || "Simple, hands-busy cooking."} <b>Swipe to browse, thumbs up to start cooking.</b>`;

    const meta = document.createElement("div");
    meta.className = "recipe-meta";
    const totalTime = r.total_time || r.time;
    if (r.cuisine)    meta.append(Chip({ label: r.cuisine, variant: "copper" }));
    if (totalTime)    meta.append(Chip({ label: totalTime }));
    if (r.difficulty) meta.append(Chip({ label: r.difficulty, variant: "sage" }));
    if (r.servings)   meta.append(Chip({ label: `${r.servings} servings` }));

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
      row.innerHTML = `<span class="num">${String(idx + 1).padStart(2, "0")}</span><span class="name">${it.name || it}</span><span class="qty">${it.qty || ""}</span>`;
      ing.append(row);
    });

    const cta = document.createElement("div");
    cta.className = "recipes-cta";
    cta.append(
      Button({ label: "Start cooking", trailingIcon: "arrowRight", onClick: () => commands.dispatch("cook", "button") }),
      Button({ label: "Read aloud",    intent: "ghost", onClick: () => commands.dispatch("read", "button") }),
      Button({ label: "Practice gestures", intent: "ghost", onClick: () => commands.dispatch("trainer", "button") }),
    );

    const featured = Bezel({ children: [meta, title, desc, ing, cta] });

    const cascade = Cascade({
      items: state.recipes.map((rr, idx) => ({
        num: `recipe ${String(idx + 1).padStart(2, "0")}`,
        title: rr.name,
        footer: [rr.cuisine, rr.total_time || rr.time,
                 rr.servings ? `${rr.servings} servings` : null].filter(Boolean),
      })),
      focusedIndex: i,
    });

    const pip = PipFrame({ video: videoEl, canvas: canvasEl, status: "tracking", confidence: 0 });
    const rightCol = document.createElement("div");
    rightCol.append(cascade, pip);

    const stage = document.createElement("div");
    stage.className = "recipes-stage";
    stage.append(featured, rightCol);

    const hud = Hud({ status: "tracking", active: null });

    // Voice Q&A toggle lives here too, so it can be set while choosing a
    // recipe -- "on the main page, while starting the cooking part".
    const navControls = document.createElement("div");
    navControls.style.cssText = "display:flex; align-items:center; gap: var(--space-4);";
    navControls.append(
      Toggle({ label: "Voice Q&A ✌", checked: state.voiceQA, onChange: (on) => state.setVoiceQA(on) }),
      Button({ label: "Home", intent: "ghost", onClick: () => commands.dispatch("home", "button") }),
    );
    const header = ScreenHeader(eyebrow, navControls);

    const wrap = document.createElement("div");
    wrap.append(header, h1, lede, stage);
    root.replaceChildren(wrap, hud);
    enter(wrap);
    return hud;
  }

  let hud = renderRecipe();

  function onAction(action) {
    const total = state.recipes.length;
    switch (action) {
      case "next":
        state.recipe_index = Math.min(total - 1, state.recipe_index + 1);
        hud = renderRecipe();
        break;
      case "back":
        state.recipe_index = Math.max(0, state.recipe_index - 1);
        hud = renderRecipe();
        break;
      case "read": {
        const r = state.recipes[state.recipe_index];
        tts.stopAll();
        tts.enqueue(`${r.name}. ${r.description || ""}`);
        break;
      }
      case "pick": {
        if (pickA == null) {
          pickA = state.recipe_index;
          tts.enqueue(`Selected ${state.recipes[pickA].name}. Swipe to pick a second, or thumbs up to cook just this one.`);
        } else if (pickB == null && state.recipe_index !== pickA) {
          pickB = state.recipe_index;
          tts.enqueue(`Selected ${state.recipes[pickB].name}. Thumbs up to cook both together.`);
        }
        break;
      }
      case "cook":
        if (pickA != null && pickB != null && pickA !== pickB) {
          state.mode = "parallel-2";
          state._parallelA = pickA; state._parallelB = pickB;
        }
        state.go("cooking");
        break;
      case "trainer": state.go("trainer"); break;
      case "home":    state.go("welcome"); break;
      case "exit":    state.go("mode"); break;
    }
  }
  commands.bind(onAction);

  function onGesture(g) {
    highlightHudGesture(hud, g);
    const action = GESTURE_ACTION[g];
    if (action) commands.dispatch(action, "gesture");
  }

  await GestureEngine.stop();
  await GestureEngine.init(videoEl, canvasEl, onGesture);
  await GestureEngine.start();
}

export function unmount() {
  commands.unbind();
  GestureEngine.stop();
  tts.stopAll();
}
