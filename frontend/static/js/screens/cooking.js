// frontend/static/js/screens/cooking.js
//
// Lifecycle: mount() builds the screen, camera and mic ONCE. Stepping through
// the recipe calls renderStep() -- it only updates the changed DOM. The webcam
// and microphone are never re-acquired mid-recipe (that used to happen on every
// step and made detection flaky).
//
// Every input -- gesture, voice, button -- routes through commands.dispatch(),
// so one intent produces exactly one action.
import { Bezel, Eyebrow, Button, PipFrame, Hud, ScreenHeader, Toggle, QaOverlay, highlightHudGesture } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { tts, Timer } from "../audio.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";
import { VoiceLoop } from "../voice.js";
import { commands } from "../commands.js";
import { runQaSession, qaActive } from "../qa.js";
import { saveMoment, captureFrame } from "../moments.js";
import { buildSchedule } from "../scheduler.js";

const GESTURE_ACTION = {
  thumbs_up: "next", swipe_right: "next", swipe_left: "back",
  open_palm: "read", open_palm_hold: "lock", fist: "exit",
  victory: "ask",
};
const VOICE_ACTION = {
  next: "next", back: "back", repeat: "read", pause: "pause", resume: "resume",
  ask: "ask", ambient_enter: "ambient", trainer: "trainer", save_moment: "save",
};

// module-level refs that unmount() needs to tear down
let voice = null;
let stepTimer = null;
let unbindTTS = null;

export async function mount(root) {
  if (state.mode === "parallel-2") return mountParallel(root);

  root.innerHTML = "";
  const r = state.recipes[state.recipe_index];
  if (!r) { state.go("recipes"); return; }
  const steps = r.steps || [];
  if (!state._epStartedAt) state._epStartedAt = Date.now();

  // ── static skeleton (built once) ──────────────────────────────────
  const eyebrow = Eyebrow({ text: r.name });

  const progress = document.createElement("div");
  progress.className = "cooking-progress";
  steps.forEach(() => {
    const p = document.createElement("div"); p.className = "pip";
    progress.append(p);
  });

  const stepEyebrow = document.createElement("div");
  stepEyebrow.className = "t-eyebrow";
  stepEyebrow.style.color = "var(--ink-3)";

  const stepText = document.createElement("div");
  stepText.className = "cooking-step-text";

  const card = Bezel({ children: [stepEyebrow, document.createElement("div"), stepText] });

  const cta = document.createElement("div");
  cta.className = "cooking-cta";
  cta.append(
    Button({ label: "Read aloud", intent: "ghost", onClick: () => commands.dispatch("read", "button") }),
    Button({ label: "Previous",   intent: "ghost", onClick: () => commands.dispatch("back", "button") }),
    Button({ label: "Next step",  trailingIcon: "arrowRight", onClick: () => commands.dispatch("next", "button") }),
  );

  const videoEl  = document.createElement("video"); videoEl.playsInline = true; videoEl.muted = true;
  const canvasEl = document.createElement("canvas"); canvasEl.width = 320; canvasEl.height = 240;
  const pip = PipFrame({ video: videoEl, canvas: canvasEl, status: "tracking", confidence: 0 });

  let currentHud = Hud({ status: "tracking", active: null });

  const navControls = document.createElement("div");
  navControls.style.cssText = "display:flex; align-items:center; gap: var(--space-4);";
  navControls.append(
    Toggle({ label: "Voice Q&A ✌", checked: state.voiceQA, onChange: (on) => state.setVoiceQA(on) }),
    Button({ label: "Back to recipes", intent: "ghost", onClick: () => commands.dispatch("exit", "button") }),
  );
  const header = ScreenHeader(eyebrow, navControls);

  // Live Q&A listening overlay -- driven by runQaSession when the user asks.
  const qaOverlay = QaOverlay();

  const wrap = document.createElement("div");
  wrap.className = "cooking-wrap";
  wrap.append(header, progress, card, cta, pip);
  root.append(wrap, currentHud, qaOverlay.el);
  enter(wrap);

  // ── per-step render (no camera/mic churn) ─────────────────────────
  function stepTextOf(i) {
    const s = steps[i];
    return typeof s === "string" ? s : (s?.text || "");
  }

  function refreshHud(active = null) {
    const timerStr = stepTimer
      ? `${Math.floor(stepTimer.remaining / 60)}:${String(stepTimer.remaining % 60).padStart(2, "0")}`
      : null;
    const newHud = Hud({
      status: state.idle ? "paused" : "tracking",
      active, timer: timerStr, locked: state.locked_step,
    });
    currentHud.replaceWith(newHud);
    currentHud = newHud;
  }

  function renderStep() {
    const i = state.step_index = Math.min(state.step_index, steps.length - 1);
    [...progress.children].forEach((p, idx) => {
      p.classList.toggle("done", idx < i);
      p.classList.toggle("current", idx === i);
    });
    stepEyebrow.textContent = `step ${String(i + 1).padStart(2, "0")} of ${String(steps.length).padStart(2, "0")}`;
    stepText.textContent = stepTextOf(i);

    if (stepTimer) { stepTimer.stop(); stepTimer = null; }
    const s = steps[i];
    const seconds = (typeof s === "object" && s?.duration_seconds) || null;
    if (seconds) {
      stepTimer = new Timer({
        seconds,
        onTick: () => refreshHud(),
        onDone: () => { stepTimer = null; refreshHud(); tts.enqueue(`Timer done for step ${i + 1}.`); },
      });
      stepTimer.start();
    }
    refreshHud();
  }

  function advance() {
    if (state.step_index + 1 >= steps.length) { tts.stopAll(); state.go("epilogue"); return; }
    state.nextStep();
    renderStep();
  }

  async function saveCurrentMoment() {
    const blob = await captureFrame(videoEl);
    const id = await saveMoment(state.session_id, state.step_index, blob);
    state._momentsCount = (state._momentsCount || 0) + 1;
    try { await api.session.event(state.session_id, "moment_saved", { step_num: state.step_index, indexeddb_key: id, ts: Date.now() }); } catch {}
    tts.enqueue(`Saved at step ${state.step_index + 1}.`);
  }

  // ── the single action handler (every input lands here) ────────────
  function onAction(action) {
    // "ask" opens a Q&A session; everything else is suppressed while one runs,
    // so a stray gesture mid-question can't skip a step.
    if (qaActive() && action !== "ask") return;

    if (state.idle && action !== "pause") {   // any command wakes from auto-pause
      state.setIdle(false);
      if (stepTimer) stepTimer.resume();
      refreshHud();
    }
    switch (action) {
      case "next":    advance(); break;
      case "back":    state.prevStep(); renderStep(); break;
      case "read":    tts.enqueue(stepText.textContent); break;
      case "lock":    state.setLocked(!state.locked_step); refreshHud();
                      tts.enqueue(state.locked_step ? "Locked." : "Released."); break;
      case "exit":    tts.stopAll(); state.go("recipes"); break;
      case "pause":   tts.stopAll(); stepTimer?.pause(); state.setIdle(true); refreshHud(); break;
      case "resume":  stepTimer?.resume(); state.setIdle(false); refreshHud(); break;
      case "ambient": state.go("ambient"); break;
      case "trainer": state.go("trainer"); break;
      case "save":    saveCurrentMoment(); break;
      case "ask":     runQaSession({
                        voice,
                        getRecipe: () => state.recipes[state.recipe_index],
                        getStep:   () => state.step_index,
                        overlay:   qaOverlay,
                      }); break;
    }
  }
  commands.bind(onAction);

  // ── gesture input ─────────────────────────────────────────────────
  function onGesture(g) {
    if (qaActive()) return;          // no navigation while a question is in flight
    highlightHudGesture(currentHud, g);
    if (g === "idle") {
      state.setIdle(true); tts.stopAll(); stepTimer?.pause(); refreshHud();
      return;
    }
    // a swipe while the step is locked is ignored; thumbs-up / fist unlock first
    if (state.locked_step && (g === "swipe_left" || g === "swipe_right")) return;
    if (state.locked_step && (g === "fist" || g === "thumbs_up")) {
      state.setLocked(false); refreshHud();
    }
    const action = GESTURE_ACTION[g];
    if (action) commands.dispatch(action, "gesture");
  }

  await GestureEngine.stop();
  await GestureEngine.init(videoEl, canvasEl, onGesture);
  await GestureEngine.start();

  // ── voice input ───────────────────────────────────────────────────
  // The loop handles voice COMMANDS only; questions are gesture-gated and
  // captured by runQaSession via voice.captureQuestion().
  voice = new VoiceLoop({
    onCommand: (a) => { const action = VOICE_ACTION[a]; if (action) commands.dispatch(action, "voice"); },
  });
  // mute the mic while TTS plays, to stop the speaker echoing into the recogniser
  unbindTTS = tts.onPlayingChange((isPlaying) => isPlaying ? voice.mute() : voice.unmute());
  voice.start();

  renderStep();
}

// ── parallel two-recipe mode (renders in place already) ─────────────
async function mountParallel(root) {
  root.innerHTML = "";
  const A = state.recipes[state._parallelA];
  const B = state.recipes[state._parallelB];
  const schedule = buildSchedule(A, B);
  let cursor = state._parCursor = state._parCursor || 0;

  const eyebrow = Eyebrow({ text: `parallel · ${A.name} + ${B.name}` });
  const stage = document.createElement("div"); stage.className = "parallel-stage";
  const laneA = document.createElement("div"); laneA.className = "parallel-lane";
  laneA.innerHTML = `<h3>${A.name}</h3><div class="step"></div>`;
  const laneB = document.createElement("div"); laneB.className = "parallel-lane";
  laneB.innerHTML = `<h3>${B.name}</h3><div class="step"></div>`;
  stage.append(laneA, laneB);

  const hud = Hud({ status: "tracking", active: null });
  const header = ScreenHeader(
    eyebrow,
    Button({ label: "Back to recipes", intent: "ghost", onClick: () => commands.dispatch("exit", "button") }),
  );
  const wrap = document.createElement("div"); wrap.className = "cooking-wrap";
  wrap.append(header, stage);
  root.append(wrap, hud);
  enter(wrap);

  function render() {
    const cur = schedule[cursor];
    laneA.classList.toggle("active", cur?.recipe === "A");
    laneB.classList.toggle("active", cur?.recipe === "B");
    const lastInLane = (recipe) => {
      for (let i = cursor; i >= 0; i--) if (schedule[i].recipe === recipe) return schedule[i];
      return null;
    };
    laneA.querySelector(".step").textContent = lastInLane("A")?.text || "ready";
    laneB.querySelector(".step").textContent = lastInLane("B")?.text || "ready";
    if (cur) tts.enqueue(`${cur.recipe === "A" ? A.name : B.name}: ${cur.text}`);
  }

  function onAction(action) {
    if (action === "next") {
      cursor = state._parCursor = Math.min(schedule.length - 1, cursor + 1);
      render();
      if (cursor === schedule.length - 1) state.go("epilogue");
    } else if (action === "back") {
      cursor = state._parCursor = Math.max(0, cursor - 1);
      render();
    } else if (action === "exit") {
      state.go("recipes");
    }
  }
  commands.bind(onAction);

  const videoEl  = document.createElement("video"); videoEl.style.display = "none"; videoEl.playsInline = true; videoEl.muted = true;
  const canvasEl = document.createElement("canvas"); canvasEl.style.display = "none"; canvasEl.width = 320; canvasEl.height = 240;
  await GestureEngine.stop();
  await GestureEngine.init(videoEl, canvasEl, (g) => {
    highlightHudGesture(hud, g);
    const action = GESTURE_ACTION[g];
    if (action === "next" || action === "back" || action === "exit") commands.dispatch(action, "gesture");
  });
  await GestureEngine.start();

  render();
}

export function unmount() {
  commands.unbind();
  unbindTTS?.(); unbindTTS = null;
  GestureEngine.stop();
  tts.stopAll();
  if (stepTimer) { stepTimer.stop(); stepTimer = null; }
  if (voice) { voice.stop(); voice = null; }
}
