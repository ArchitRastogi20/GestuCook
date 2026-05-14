// frontend/static/js/screens/cooking.js
import { Bezel, Eyebrow, Button, PipFrame, Hud } from "../ui/components.js";
import { state } from "../state.js";
import { TTSQueue } from "../audio.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";

const tts = new TTSQueue();
let videoEl, canvasEl, currentHud;

export async function mount(root) {
  root.innerHTML = "";
  const r = state.recipes[state.recipe_index];
  if (!r) { state.go("recipes"); return; }
  const steps = r.steps || [];
  const i = state.step_index = Math.min(state.step_index, steps.length - 1);

  const eyebrow = Eyebrow({ text: `${r.name}` });

  const progress = document.createElement("div");
  progress.className = "cooking-progress";
  steps.forEach((_, idx) => {
    const p = document.createElement("div"); p.className = "pip";
    if (idx < i) p.classList.add("done");
    if (idx === i) p.classList.add("current");
    progress.append(p);
  });

  const stepEyebrow = document.createElement("div");
  stepEyebrow.className = "t-eyebrow";
  stepEyebrow.style.color = "var(--ink-3)";
  stepEyebrow.textContent = `step ${String(i+1).padStart(2,"0")} of ${String(steps.length).padStart(2,"0")}`;

  const stepText = document.createElement("div");
  stepText.className = "cooking-step-text";
  stepText.textContent = typeof steps[i] === "string" ? steps[i] : (steps[i]?.text || "");

  const card = Bezel({ children: [stepEyebrow, document.createElement("div"), stepText] });

  const cta = document.createElement("div");
  cta.className = "cooking-cta";
  cta.append(
    Button({ label: "Read aloud", intent: "ghost", onClick: () => tts.enqueue(stepText.textContent) }),
    Button({ label: "Previous",   intent: "ghost", onClick: () => { state.prevStep(); mount(root); } }),
    Button({ label: "Next step",  trailingIcon: "arrowRight", onClick: () => advance() }),
    Button({ label: "Exit",       intent: "ghost", onClick: () => { tts.stopAll(); state.go("recipes"); } }),
  );

  videoEl  = document.createElement("video"); videoEl.playsInline = true; videoEl.muted = true;
  canvasEl = document.createElement("canvas"); canvasEl.width = 320; canvasEl.height = 240;
  const pip = PipFrame({ video: videoEl, canvas: canvasEl, status: "tracking", confidence: 0 });

  currentHud = Hud({ status: "tracking", active: null });

  const wrap = document.createElement("div");
  wrap.className = "cooking-wrap";
  wrap.append(eyebrow, progress, card, cta, pip);
  root.append(wrap, currentHud);
  enter(wrap);

  await GestureEngine.init(videoEl, canvasEl, (g) => onGesture(g));
  GestureEngine.start();

  function onGesture(g) {
    if (currentHud) {
      for (const p of currentHud.querySelectorAll(".gp")) p.classList.remove("on");
      const pill = currentHud.querySelector(`[data-gesture="${g}"]`);
      if (pill) pill.classList.add("on");
    }
    if (g === "swipe_right" || g === "thumbs_up") advance();
    if (g === "swipe_left")  { state.prevStep(); mount(root); }
    if (g === "open_palm")   tts.enqueue(stepText.textContent);
    if (g === "fist")        { tts.stopAll(); state.go("recipes"); }
  }

  function advance() {
    if (i + 1 >= steps.length) { tts.stopAll(); state.go("recipes"); return; }
    state.nextStep(); mount(root);
  }
}

export function unmount() {
  GestureEngine.stop();
  tts.stopAll();
}
