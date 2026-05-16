// frontend/static/js/screens/ambient.js
// Kitchen mode: huge step text, webcam hidden. mount() sets up camera, mic and
// the step display once; stepping only re-renders text.
import { state } from "../state.js";
import { Hud, highlightHudGesture } from "../ui/components.js";
import { GestureEngine } from "../gestures.js";
import { tts } from "../audio.js";
import { VoiceLoop } from "../voice.js";
import { enter } from "../ui/motion.js";
import { commands } from "../commands.js";

const GESTURE_ACTION = {
  swipe_right: "next", thumbs_up: "next", swipe_left: "back",
  pointing_up: "exit", fist: "exit",
};
const VOICE_ACTION = {
  next: "next", back: "back", repeat: "read", ambient_exit: "exit",
};

let voice = null;
let unbindTTS = null;

export async function mount(root) {
  root.innerHTML = "";

  const r = state.recipes[state.recipe_index];
  if (!r) { state.go("recipes"); return; }
  const steps = r.steps || [];

  const wrap = document.createElement("div");
  wrap.className = "ambient";
  const step = document.createElement("div"); step.className = "step";
  const meta = document.createElement("div"); meta.className = "meta";
  const video  = document.createElement("video"); video.style.display = "none"; video.playsInline = true; video.muted = true;
  const canvas = document.createElement("canvas"); canvas.style.display = "none"; canvas.width = 320; canvas.height = 240;
  wrap.append(step, meta, video, canvas);

  let hud = Hud({ status: "tracking", active: null });
  root.append(wrap, hud);
  enter(wrap);

  const stepTextOf = (i) => {
    const s = steps[i];
    return typeof s === "string" ? s : (s?.text || "");
  };

  function renderStep(speak = true) {
    const i = state.step_index = Math.min(state.step_index, steps.length - 1);
    step.textContent = stepTextOf(i);
    meta.textContent = `step ${i + 1} of ${steps.length}  ·  kitchen mode`;
    if (speak) tts.enqueue(stepTextOf(i));
  }

  function onAction(action) {
    switch (action) {
      case "next":
        if (state.step_index + 1 >= steps.length) state.go("epilogue");
        else { state.nextStep(); renderStep(); }
        break;
      case "back": state.prevStep(); renderStep(); break;
      case "read": tts.enqueue(stepTextOf(state.step_index)); break;
      case "exit": state.go("cooking"); break;
    }
  }
  commands.bind(onAction);

  function onGesture(g) {
    highlightHudGesture(hud, g);
    const action = GESTURE_ACTION[g];
    if (action) commands.dispatch(action, "gesture");
  }

  await GestureEngine.stop();
  await GestureEngine.init(video, canvas, onGesture);
  await GestureEngine.start();

  voice = new VoiceLoop({
    onCommand: (a) => { const action = VOICE_ACTION[a]; if (action) commands.dispatch(action, "voice"); },
  });
  // mute the mic while narration plays, so the recogniser can't hear the speaker
  unbindTTS = tts.onPlayingChange((isPlaying) => isPlaying ? voice.mute() : voice.unmute());
  voice.start();

  renderStep();
}

export function unmount() {
  commands.unbind();
  unbindTTS?.(); unbindTTS = null;
  GestureEngine.stop();
  tts.stopAll();
  if (voice) { voice.stop(); voice = null; }
}
