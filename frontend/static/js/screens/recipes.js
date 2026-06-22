// frontend/static/js/screens/recipes.js
// Browse generated recipes. mount() starts the camera once; changing recipe
// re-renders the page but REUSES the same <video>/<canvas>, so the webcam
// stream is never interrupted. All input routes through the command arbiter.
import { Bezel, Eyebrow, Chip, Button, PipFrame, Hud, Cascade, ScreenHeader, Toggle, highlightHudGesture, Snackbar, setLoading } from "../ui/components.js";
import { state } from "../state.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";
import { tts, chime } from "../audio.js";
import { commands } from "../commands.js";
import { t } from "../i18n.js";
import { api } from "../api.js";

const GESTURE_ACTION = {
  swipe_right: "next", swipe_left: "back",
  thumbs_up: "cook", fist: "exit", victory: "pick",
  open_palm: "read",
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
  let recipesSnackbar = null;
  let snackbarOpen = false;

  function renderRecipe() {
    const i = state.recipe_index;
    const total = state.recipes.length;
    const r = state.recipes[i];

    const eyebrow = Eyebrow({ text: t("rec.eyebrow", { i: String(i + 1).padStart(2, "0"), n: String(total).padStart(2, "0") }) });

    const h1 = document.createElement("h1");
    h1.className = "t-display-xl";
    h1.style.maxWidth = "16ch";
    h1.innerHTML = t("rec.heading", { cuisine: r.cuisine || t("rec.dish") });

    const lede = document.createElement("p");
    lede.className = "t-body";
    lede.style.marginTop = "var(--space-4)";
    lede.innerHTML = `${r.description || t("rec.ledeFallback")} ${t("rec.ledeHint")}`;

    const meta = document.createElement("div");
    meta.className = "recipe-meta";
    const totalTime = r.total_time || r.time;
    if (r.cuisine)    meta.append(Chip({ label: r.cuisine, variant: "copper" }));
    if (totalTime)    meta.append(Chip({ label: totalTime }));
    if (r.difficulty) meta.append(Chip({ label: r.difficulty, variant: "sage" }));
    if (r.servings)   meta.append(Chip({ label: t("rec.servings", { n: r.servings }) }));

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
      Button({ label: t("rec.start"), trailingIcon: "arrowRight", onClick: () => commands.dispatch("cook", "button") }),
      Button({ label: t("rec.read"),    intent: "ghost", onClick: () => commands.dispatch("read", "button") }),
      Button({ label: t("rec.practice"), intent: "ghost", onClick: () => commands.dispatch("trainer", "button") }),
    );

    const featured = Bezel({ children: [meta, title, desc, ing, cta] });

    const cascade = Cascade({
      items: state.recipes.map((rr, idx) => ({
        num: t("rec.cardNum", { nn: String(idx + 1).padStart(2, "0") }),
        title: rr.name,
        footer: [rr.cuisine, rr.total_time || rr.time,
                 rr.servings ? t("rec.servings", { n: rr.servings }) : null].filter(Boolean),
      })),
      focusedIndex: i,
    });

    const pip = PipFrame({ video: videoEl, canvas: canvasEl, status: t("hud.tracking"), confidence: 0 });
    const rightCol = document.createElement("div");
    rightCol.append(cascade, pip);

    const stage = document.createElement("div");
    stage.className = "recipes-stage";
    stage.append(featured, rightCol);

    const hud = Hud({ status: t("hud.tracking"), active: null });

    // Voice Q&A toggle lives here too, so it can be set while choosing a
    // recipe -- "on the main page, while starting the cooking part".
    const navControls = document.createElement("div");
    navControls.style.cssText = "display:flex; align-items:center; gap: var(--space-4);";
    const regen = document.createElement('button');
    regen.className = 'btn btn--ghost'; regen.type = 'button'; regen.textContent = 'Regenerate';
    regen.addEventListener('click', () => {
      // gather current ingredients and open confirm modal
      const allIngredients = [];
      for (const rr of state.recipes) {
        for (const it of (rr.ingredients || [])) {
          const name = typeof it === 'string' ? it : (it.name || '');
          if (name) allIngredients.push(name);
        }
      }
      showRegenerateModal(allIngredients);
    });

    navControls.append(
      regen,
      Toggle({ label: t("common.voiceQA"), checked: state.voiceQA, onChange: (on) => state.setVoiceQA(on) }),
      Button({ label: t("common.home"), intent: "ghost", onClick: () => commands.dispatch("home", "button") }),
    );
    const header = ScreenHeader(eyebrow, navControls);

    const wrap = document.createElement("div");
    wrap.append(header, h1, lede, stage);
    root.replaceChildren(wrap, hud);
    enter(wrap);
    return hud;
  }

  function showRegenerateModal(ingredients) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.position = 'fixed'; overlay.style.left = '0'; overlay.style.top = '0';
    overlay.style.width = '100%'; overlay.style.height = '100%'; overlay.style.display = 'flex';
    overlay.style.alignItems = 'center'; overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(0,0,0,0.45)'; overlay.style.zIndex = '10000';

    const card = document.createElement('div');
    card.className = 'bezel';
    card.style.padding = '18px'; card.style.maxWidth = '520px'; card.style.width = '90%';
    card.style.backgroundColor = 'var(--bg, #fff)';
    card.style.borderRadius = '12px';
    card.style.boxShadow = '0 8px 32px rgba(0,0,0,0.18)';

    const title = document.createElement('h3'); title.textContent = 'Do you want to regenerate the recipes?';
    const p = document.createElement('p'); p.textContent = 'Existing recipes will be regenerated using the current ingredients. You can wait for the completion or cancel.';
    const btns = document.createElement('div'); btns.style.display = 'flex'; btns.style.gap = '8px'; btns.style.marginTop = '12px';

    const cancel = Button({ label: 'Cancel', intent: 'ghost', onClick: () => remove() });

    const confirm = Button({
      label: 'Regenerate',
      onClick: async () => {
        setLoading(confirm, true, 'Regenerating...');
        try {
          console.log('regen start', ingredients);
          const res = await api.generateRecipes(ingredients, null, state.language);
          console.log('regen res', res);
          if (res?.recipes) {
            state.setRecipes(res.recipes);
            hud = renderRecipe();
          }
        } catch (e) {
          console.error('regen error', e);
          setLoading(confirm, false);
        }
        remove();
      }
    }); 
    confirm.style.padding = '10px var(--space-4)';

    btns.append(cancel, confirm);
    card.append(title, p, btns);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function remove() { try { overlay.remove(); } catch (e) {} }
  }

  let hud = renderRecipe();

  // Global snackbar for quick undo/confirm feedback
  recipesSnackbar = Snackbar();

  // Attach gesture feedback hook: audible chime + hud highlight
  GestureEngine._onFire = (action) => {
    try { chime(); } catch (e) {}
    try { highlightHudGesture(hud, action); } catch (e) {}
    setTimeout(() => { try { highlightHudGesture(hud, null); } catch (e) {} }, 600);
  };

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
          tts.enqueue(t("rec.ttsSelectedFirst", { name: state.recipes[pickA].name }));
        } else if (pickB == null && state.recipe_index !== pickA) {
          pickB = state.recipe_index;
          tts.enqueue(t("rec.ttsSelectedSecond", { name: state.recipes[pickB].name }));
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
      case "exit":
        if (snackbarOpen) return; 
        snackbarOpen = true;
        recipesSnackbar.show('Exit recipe view?', {
          timeout: 0,
          confirmText: 'Confirm',
          onConfirm: () => { snackbarOpen = false; state.go('mode'); },
          cancelText: 'Cancel',
          onCancel: () => { snackbarOpen = false; recipesSnackbar.hide(); },
        });
        break;
    }
  }
  commands.bind(onAction);

  function onGesture(g) {
    if (snackbarOpen) return;        // no navigation while a snackbar is open
    highlightHudGesture(hud, g);
    // If user shows an open palm while browsing recipes, immediately read
    // the recipe aloud. This bypasses the global command arbiter which can
    // sometimes debounce or mis-route the action (e.g. accidental "back").
    if (g === "open_palm") {
      const r = state.recipes[state.recipe_index];
      if (r) {
        tts.stopAll();
        tts.enqueue(`${r.name}. ${r.description || ""}`);
      }
      return;
    }

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
  try {
    if (recipesSnackbar && recipesSnackbar.el && recipesSnackbar.el.parentNode) recipesSnackbar.el.parentNode.removeChild(recipesSnackbar.el);
  } catch (e) {}
  try { GestureEngine._onFire = undefined; } catch (e) {}
}
