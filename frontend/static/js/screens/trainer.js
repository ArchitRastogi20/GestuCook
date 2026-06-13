// frontend/static/js/screens/trainer.js
// The trainer drives the SAME GestureEngine the cooking screens use, so a
// gesture practised here behaves identically once you're cooking. The progress
// bar mirrors the engine's own time-windowed vote.
import { Bezel, Eyebrow, Button } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { tts } from "../audio.js";
import { enter } from "../ui/motion.js";
import { GestureEngine, TO_ACTION } from "../gestures.js";
import { t } from "../i18n.js";

export async function mount(root) {
  GestureEngine.stop();   // tear down any stream a previous screen left running
  root.innerHTML = "";
  let idx = 0;
  let done = false;

  // Built per-mount so labels/prompts localize to the session language.
  const STEPS = [
    { name: "Thumb_Up",    label: t("tr.thumbs.label"),  prompt: t("tr.thumbs.prompt") },
    { name: "Closed_Fist", label: t("tr.fist.label"),    prompt: t("tr.fist.prompt") },
    { name: "Open_Palm",   label: t("tr.palm.label"),    prompt: t("tr.palm.prompt") },
    { name: "Victory",     label: t("tr.victory.label"), prompt: t("tr.victory.prompt") },
    { name: "Pointing_Up", label: t("tr.point.label"),   prompt: t("tr.point.prompt") },
  ];

  const wrap = document.createElement("div");
  wrap.className = "trainer-wrap";

  const eyebrow = Eyebrow({ text: t("tr.eyebrow") });
  const lede = document.createElement("p");
  lede.className = "trainer-lede t-body";
  lede.textContent = t("tr.lede");
  const h1 = document.createElement("h2");
  const p  = document.createElement("p");
  const bar = document.createElement("div"); bar.className = "trainer-conf";
  const fill = document.createElement("div"); bar.append(fill);
  const dots = document.createElement("div"); dots.className = "trainer-dots";
  STEPS.forEach(() => dots.append(document.createElement("i")));
  const cta = document.createElement("div");
  cta.style.cssText = "margin-top: var(--space-5); display:flex; gap: var(--space-4);";
  cta.append(
    Button({ label: t("tr.skip"), intent: "ghost", onClick: () => finish(false) }),
    Button({ label: t("tr.exit"), intent: "ghost", onClick: () => finish(false) }),
  );
  const promptCol = document.createElement("div"); promptCol.className = "trainer-prompt";
  promptCol.append(h1, p, bar, dots, cta);

  const pipBox = document.createElement("div"); pipBox.className = "trainer-pip";
  const video  = document.createElement("video"); video.playsInline = true; video.muted = true;
  const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
  pipBox.append(video, canvas);
  const pipBezel = Bezel({ children: [pipBox] });

  const stage = document.createElement("div"); stage.className = "trainer-stage";
  stage.append(promptCol, pipBezel);
  wrap.append(eyebrow, lede, stage);
  root.append(wrap);
  enter(wrap);

  await GestureEngine.init(video, canvas, onGesture);
  GestureEngine.setFrameObserver(onFrame);
  await GestureEngine.start();
  setStep(0);

  function setStep(i) {
    idx = i;
    h1.textContent = STEPS[i].label;
    p.textContent  = STEPS[i].prompt;
    fill.style.width = "0%";
    [...dots.children].forEach((d, k) => {
      d.classList.toggle("done", k < i);
      d.classList.toggle("current", k === i);
    });
    tts.enqueue(STEPS[i].prompt);
  }

  // Live progress: the engine's vote fill for the pose we're asking for.
  function onFrame(info) {
    if (done) return;
    const want = STEPS[idx].name;
    const pct = (info.hasHand && info.voteLabel === want) ? info.voteFill : 0;
    fill.style.width = `${Math.round(pct * 100)}%`;
  }

  // The engine fired a confirmed gesture -- advance only if it's the target.
  function onGesture(g) {
    if (done) return;
    if (g !== TO_ACTION[STEPS[idx].name]) return;
    tts.enqueue(t("tr.ttsGot"));
    if (idx + 1 < STEPS.length) setStep(idx + 1);
    else finish(true);
  }

  async function finish(completed) {
    done = true;
    GestureEngine.setFrameObserver(null);
    GestureEngine.stop();
    // any exit counts as onboarding seen — never nag a returning user
    try { localStorage.setItem("gestucook.trainerDone", "1"); } catch {}
    if (completed && state.user?.name) {
      try { await api.session.trainerCompleted(state.user.name); } catch {}
      tts.enqueue(t("tr.ttsDone"));
    }
    // onboarding (no recipes yet) lands in mode-pick; practice from the
    // recipes screen returns to recipes
    state.go(state.recipes.length ? "recipes" : "mode");
  }
}

export function unmount() {
  GestureEngine.setFrameObserver(null);
  GestureEngine.stop();
  tts.stopAll();
}
