// frontend/static/js/screens/cooking.js
import { Bezel, Eyebrow, Button, PipFrame, Hud } from "../ui/components.js";
import { state } from "../state.js";
import { TTSQueue, Timer } from "../audio.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";

const tts = new TTSQueue();
let videoEl, canvasEl, currentHud;
let stepTimer = null;

export async function mount(root) {
  root.innerHTML = "";
  const r = state.recipes[state.recipe_index];
  if (!r) { state.go("recipes"); return; }
  const steps = r.steps || [];
  const i = state.step_index = Math.min(state.step_index, steps.length - 1);

  // record when the cooking session started (used by epilogue for duration)
  if (!state._epStartedAt) state._epStartedAt = Date.now();

  // stop any lingering timer from the previous step
  if (stepTimer) { stepTimer.stop(); stepTimer = null; }

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

  const step = steps[i];
  const stepTextContent = typeof step === "string" ? step : (step?.text || "");
  const seconds = (typeof step === "object" && step?.duration_seconds) || null;

  const stepText = document.createElement("div");
  stepText.className = "cooking-step-text";
  stepText.textContent = stepTextContent;

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

  function refreshHud(active = null) {
    const timerStr = stepTimer
      ? `${Math.floor(stepTimer.remaining / 60)}:${String(stepTimer.remaining % 60).padStart(2, "0")}`
      : null;
    const newHud = Hud({
      status: state.idle ? "paused" : "tracking",
      active,
      timer: timerStr,
      locked: state.locked_step,
    });
    if (currentHud) currentHud.replaceWith(newHud);
    currentHud = newHud;
  }

  if (seconds) {
    stepTimer = new Timer({
      seconds,
      onTick: () => refreshHud(),
      onDone: () => {
        stepTimer = null;
        refreshHud();
        tts.enqueue(`Timer done for step ${i + 1}.`);
      },
    });
    stepTimer.start();
  }
  refreshHud();

  await GestureEngine.init(videoEl, canvasEl, (g) => onGesture(g));
  GestureEngine.start();

  function onGesture(g) {
    if (currentHud) {
      for (const p of currentHud.querySelectorAll(".gp")) p.classList.remove("on");
      const pill = currentHud.querySelector(`[data-gesture="${g}"]`);
      if (pill) pill.classList.add("on");
    }

    // B2: auto-pause on hand absence
    if (g === "idle") {
      state.setIdle(true);
      tts.stopAll();
      if (stepTimer) stepTimer.pause();
      refreshHud();
      return;
    }

    // B2: soft resume on any non-idle gesture while paused
    if (state.idle && g !== "idle") {
      state.setIdle(false);
      if (stepTimer) stepTimer.resume();
      refreshHud();
      tts.enqueue(`Picking up where we were. ${stepText.textContent}`);
    }

    // B3: handle open_palm_hold to toggle sticky lock
    if (g === "open_palm_hold") {
      state.setLocked(!state.locked_step);
      refreshHud();
      tts.enqueue(state.locked_step ? "Locked." : "Released.");
      return;
    }

    // B3: when locked, ignore navigational gestures
    if (state.locked_step && (g === "swipe_left" || g === "swipe_right")) return;

    // B3: fist or thumbs_up while locked releases lock first, then falls through
    if (state.locked_step && (g === "fist" || g === "thumbs_up")) {
      state.setLocked(false);
      refreshHud();
      // fall through to normal handling
    }

    if (g === "swipe_right" || g === "thumbs_up") advance();
    if (g === "swipe_left")  { state.prevStep(); mount(root); }
    if (g === "open_palm")   tts.enqueue(stepText.textContent);
    if (g === "fist")        { tts.stopAll(); state.go("recipes"); }
  }

  function advance() {
    if (i + 1 >= steps.length) { tts.stopAll(); state.go("epilogue"); return; }
    state.nextStep(); mount(root);
  }
}

export function unmount() {
  GestureEngine.stop();
  tts.stopAll();
  if (stepTimer) { stepTimer.stop(); stepTimer = null; }
}
