// frontend/static/js/screens/trainer.js
import { Bezel, Eyebrow, Button } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { TTSQueue } from "../audio.js";
import { enter } from "../ui/motion.js";
import { FilesetResolver, GestureRecognizer } from "/static/vendor/mediapipe/vision_bundle.mjs";

const tts = new TTSQueue();
const STEPS = [
  { name: "Thumb_Up",    label: "thumbs up",  prompt: "Show me a thumbs up." },
  { name: "Closed_Fist", label: "closed fist",prompt: "Now a closed fist." },
  { name: "Open_Palm",   label: "open palm",  prompt: "Now an open palm." },
  { name: "Victory",     label: "peace sign", prompt: "Now a peace sign (V)." },
  { name: "Pointing_Up", label: "point up",   prompt: "Now point your index finger up." },
];

export async function mount(root) {
  root.innerHTML = "";
  let idx = 0;
  let sustainedSince = 0;
  let done = false;
  let recognizer = null;

  const wrap = document.createElement("div");
  wrap.className = "trainer-wrap";

  const eyebrow = Eyebrow({ text: "gesture trainer" });
  const h1 = document.createElement("h2");
  const p  = document.createElement("p");
  const bar = document.createElement("div"); bar.className = "trainer-conf"; const fill = document.createElement("div"); bar.append(fill);
  const cta = document.createElement("div"); cta.style.cssText = "margin-top: var(--space-5); display:flex; gap: var(--space-3);";
  cta.append(
    Button({ label: "Skip", intent: "ghost", onClick: () => finish(false) }),
    Button({ label: "Exit", intent: "ghost", onClick: () => state.go("recipes") }),
  );
  const promptCol = document.createElement("div"); promptCol.className = "trainer-prompt";
  promptCol.append(h1, p, bar, cta);

  const pipBox = document.createElement("div"); pipBox.className = "trainer-pip";
  const video  = document.createElement("video"); video.playsInline = true; video.muted = true;
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
  pipBox.append(video, canvas);
  const pipBezel = Bezel({ children: [pipBox] });

  const stage = document.createElement("div"); stage.className = "trainer-stage";
  stage.append(promptCol, pipBezel);
  wrap.append(eyebrow, stage);
  root.append(wrap);
  enter(wrap);

  const vision = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
  recognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "/static/vendor/mediapipe/gesture_recognizer.task", delegate: "GPU" },
    runningMode: "VIDEO", numHands: 1,
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
  video.srcObject = stream; await video.play();

  setStep(0);
  loop();

  function setStep(i) {
    idx = i; sustainedSince = 0;
    h1.textContent = STEPS[i].label;
    p.textContent = STEPS[i].prompt;
    fill.style.width = "0%";
    tts.enqueue(STEPS[i].prompt);
  }
  async function loop() {
    if (done) return;
    const now = performance.now();
    if (video.readyState >= 2 && recognizer) {
      const res = await recognizer.recognizeForVideo(video, now);
      const top = res.gestures?.[0]?.[0];
      const want = STEPS[idx].name;
      const score = (top && top.categoryName === want) ? top.score : 0;
      fill.style.width = `${Math.min(100, score * 100).toFixed(0)}%`;
      if (score >= 0.85) {
        if (!sustainedSince) sustainedSince = now;
        if (now - sustainedSince >= 1000) {
          tts.enqueue("Got it.");
          if (idx + 1 < STEPS.length) setStep(idx + 1);
          else finish(true);
        }
      } else {
        sustainedSince = 0;
      }
    }
    requestAnimationFrame(loop);
  }
  async function finish(completed) {
    done = true;
    stream.getTracks().forEach(t => t.stop());
    if (completed && state.user?.name) {
      try { await api.session.trainerCompleted(state.user.name); } catch {}
      tts.enqueue("All gestures learned. Nicely done.");
    }
    state.go("recipes");
  }
}

export function unmount() { tts.stopAll(); }
