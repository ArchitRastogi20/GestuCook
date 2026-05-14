// frontend/static/js/screens/ambient.js
import { state } from "../state.js";
import { Hud, highlightHudGesture } from "../ui/components.js";
import { GestureEngine } from "../gestures.js";
import { TTSQueue } from "../audio.js";
import { VoiceLoop } from "../voice.js";
import { enter } from "../ui/motion.js";

const tts = new TTSQueue();
let voice = null;
let video, canvas;

export async function mount(root) {
  root.innerHTML = "";

  const r = state.recipes[state.recipe_index];
  if (!r) { state.go("recipes"); return; }
  const steps = r.steps || [];
  const i = state.step_index = Math.min(state.step_index, steps.length - 1);

  const wrap = document.createElement("div");
  wrap.className = "ambient";

  const stepText = typeof steps[i] === "string" ? steps[i] : (steps[i]?.text || "");
  const step = document.createElement("div");
  step.className = "step";
  step.textContent = stepText;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `step ${i+1} of ${steps.length}  ·  kitchen mode`;

  wrap.append(step, meta);

  // hidden video/canvas for gesture engine
  video = document.createElement("video"); video.style.display = "none"; video.playsInline = true; video.muted = true;
  canvas = document.createElement("canvas"); canvas.style.display = "none"; canvas.width = 320; canvas.height = 240;
  wrap.append(video, canvas);

  const hud = Hud({ status: "tracking", active: null });
  root.append(wrap, hud);
  enter(wrap);

  await GestureEngine.init(video, canvas, onGesture);
  GestureEngine.start();

  voice = new VoiceLoop({
    onCommand: (action) => {
      if (action === "ambient_exit") { state.go("cooking"); return; }
      if (action === "next")  next();
      if (action === "back")  prev();
      if (action === "repeat") tts.enqueue(stepText);
    },
  });
  voice.start();
  tts.enqueue(stepText);

  function onGesture(g) {
    highlightHudGesture(hud, g);
    if (g === "swipe_right" || g === "thumbs_up") next();
    if (g === "swipe_left")  prev();
    if (g === "pointing_up") state.go("cooking");
    if (g === "fist")        state.go("cooking");
  }
  function next() { if (i + 1 >= steps.length) state.go("epilogue"); else { state.nextStep(); mount(root); } }
  function prev() { state.prevStep(); mount(root); }
}

export function unmount() { GestureEngine.stop(); tts.stopAll(); voice?.stop(); }
