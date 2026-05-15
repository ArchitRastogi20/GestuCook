// frontend/static/js/screens/cooking.js
import { Bezel, Eyebrow, Button, PipFrame, Hud, highlightHudGesture } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { TTSQueue, Timer } from "../audio.js";
import { enter } from "../ui/motion.js";
import { GestureEngine } from "../gestures.js";
import { VoiceLoop } from "../voice.js";
import { saveMoment, loadMoments, captureFrame } from "../moments.js";
import { buildSchedule } from "../scheduler.js";

const tts = new TTSQueue();
let videoEl, canvasEl, currentHud;
let stepTimer = null;
let voice = null;
let unbindTTS = null;

export async function mount(root) {
  if (state.mode === "parallel-2") {
    return mountParallel(root);
  }

  GestureEngine.stop();  // tear down any previous stream before we start a new one
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

  async function saveCurrentMoment() {
    if (!videoEl) return;
    const blob = await captureFrame(videoEl);
    const id = await saveMoment(state.session_id, state.step_index, blob);
    state._momentsCount = (state._momentsCount || 0) + 1;
    try { await api.session.event(state.session_id, "moment_saved", { step_num: state.step_index, indexeddb_key: id, ts: Date.now() }); } catch {}
    tts.enqueue(`Saved at step ${state.step_index + 1}.`);
  }

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

  if (voice) { voice.stop(); voice = null; }
  voice = new VoiceLoop({
    onCommand: (action) => {
      if (action === "next")    advance();
      if (action === "back")    { state.prevStep(); mount(root); }
      if (action === "repeat")  tts.enqueue(stepText.textContent);
      if (action === "pause")   { tts.stopAll(); stepTimer?.pause(); state.setIdle(true); refreshHud(); }
      if (action === "resume")  { stepTimer?.resume(); state.setIdle(false); refreshHud(); }
      if (action === "ambient_enter") state.go("ambient");
      if (action === "trainer") state.go("trainer");
      if (action === "save_moment") saveCurrentMoment();
    },
    onQA: async (question) => {
      if (!state.recipes[state.recipe_index]) return;
      const recipe = state.recipes[state.recipe_index];
      try {
        const res = await api.qa({
          session_id: state.session_id,
          current_recipe: recipe,
          current_step_index: state.step_index,
          question,
        });
        state.addCost({ usd: res.cost_delta_usd, in: res.tokens_in, out: res.tokens_out });
        state._qaCount = (state._qaCount || 0) + 1;
        tts.enqueue(res.answer);
      } catch (e) {
        tts.enqueue("Sorry, I couldn't answer that.");
      }
    },
  });

  // mute mic while TTS plays to prevent echo, using proper listener (not monkey-patch)
  if (unbindTTS) unbindTTS();
  unbindTTS = tts.onPlayingChange((isPlaying) => {
    if (isPlaying) voice?.mute();
    else           voice?.unmute();
  });

  voice.start();

  function onGesture(g) {
    highlightHudGesture(currentHud, g);

    if (g === "idle") {
      state.setIdle(true);
      tts.stopAll();
      if (stepTimer) stepTimer.pause();
      refreshHud();
      return;
    }

    if (state.idle && g !== "idle") {
      state.setIdle(false);
      if (stepTimer) stepTimer.resume();
      refreshHud();
      tts.enqueue(`Picking up where we were. ${stepText.textContent}`);
    }

    if (g === "open_palm_hold") {
      state.setLocked(!state.locked_step);
      refreshHud();
      tts.enqueue(state.locked_step ? "Locked." : "Released.");
      return;
    }

    if (state.locked_step && (g === "swipe_left" || g === "swipe_right")) return;

    // fist or thumbs_up while locked releases lock first, then falls through
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

async function mountParallel(root) {
  GestureEngine.stop();  // tear down any previous stream before we start a new one
  root.innerHTML = "";
  const A = state.recipes[state._parallelA];
  const B = state.recipes[state._parallelB];
  const schedule = buildSchedule(A, B);
  let cursor = state._parCursor = state._parCursor || 0;

  const eyebrow = Eyebrow({ text: `parallel · ${A.name} + ${B.name}` });

  const stage = document.createElement("div");
  stage.className = "parallel-stage";

  const laneA = document.createElement("div"); laneA.className = "parallel-lane";
  laneA.innerHTML = `<h3>${A.name}</h3><div class="step"></div>`;
  const laneB = document.createElement("div"); laneB.className = "parallel-lane";
  laneB.innerHTML = `<h3>${B.name}</h3><div class="step"></div>`;

  function render() {
    const cur = schedule[cursor];
    laneA.classList.toggle("active", cur?.recipe === "A");
    laneB.classList.toggle("active", cur?.recipe === "B");

    // last entry FROM THIS RECIPE at or before the cursor
    const lastInLane = (recipe) => {
      for (let i = cursor; i >= 0; i--) {
        if (schedule[i].recipe === recipe) return schedule[i];
      }
      return null;
    };
    const lastA = lastInLane("A");
    const lastB = lastInLane("B");

    laneA.querySelector(".step").textContent = lastA?.text || "ready";
    laneB.querySelector(".step").textContent = lastB?.text || "ready";

    if (cur) tts.enqueue(`${cur.recipe === "A" ? A.name : B.name}: ${cur.text}`);
  }

  stage.append(laneA, laneB);
  const wrap = document.createElement("div");
  wrap.className = "cooking-wrap";
  wrap.append(eyebrow, stage);

  const hud = Hud({ status: "tracking", active: null });
  root.append(wrap, hud);
  enter(wrap);

  videoEl  = document.createElement("video"); videoEl.style.display = "none"; videoEl.playsInline = true; videoEl.muted = true;
  canvasEl = document.createElement("canvas"); canvasEl.style.display = "none"; canvasEl.width = 320; canvasEl.height = 240;
  await GestureEngine.init(videoEl, canvasEl, (g) => {
    if (g === "swipe_right" || g === "thumbs_up") {
      cursor = state._parCursor = Math.min(schedule.length - 1, cursor + 1);
      render();
      if (cursor === schedule.length - 1) state.go("epilogue");
    }
    if (g === "swipe_left") {
      cursor = state._parCursor = Math.max(0, cursor - 1);
      render();
    }
    if (g === "fist") state.go("recipes");
  });
  GestureEngine.start();

  render();
}

export function unmount() {
  unbindTTS?.();
  GestureEngine.stop();
  tts.stopAll();
  if (stepTimer) { stepTimer.stop(); stepTimer = null; }
  if (voice) { voice.stop(); voice = null; }
}
