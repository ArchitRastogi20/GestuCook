// frontend/static/js/screens/handsfree.js
import { Bezel, Eyebrow, Button, Chip } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { enter } from "../ui/motion.js";
import { svg, ICONS } from "../ui/icons.js";

export function mount(root) {
  root.innerHTML = "";

  const eyebrow = Eyebrow({ text: "step 2 · tell us what you have" });

  const h2 = document.createElement("h2");
  h2.className = "t-display-l";
  h2.style.cssText = "text-align:center; margin-bottom: var(--space-3);";
  h2.innerHTML = `Say it <span class="italic">aloud</span>.`;

  const sub = document.createElement("p");
  sub.className = "t-body";
  sub.style.cssText = "text-align:center; margin: 0 auto var(--space-6);";
  sub.textContent = "Press the mic, list your ingredients, release. We'll transcribe.";

  const mic = document.createElement("button");
  mic.className = "mic-btn";
  mic.append(svg(ICONS.mic, { size: 32, stroke: 1.5 }));

  const transcript = document.createElement("div");
  transcript.className = "voice-transcript";
  transcript.textContent = "Press the mic to start speaking.";

  const ingredientsList = document.createElement("div");
  ingredientsList.className = "ingredients-list";

  let detected = [];
  const goBtn = Button({
    label: "Generate recipes",
    trailingIcon: "arrowRight",
    onClick: async () => {
      if (!detected.length) return;
      const recipes = await api.generateRecipes(detected, null);
      state.setRecipes(recipes.recipes || recipes);
      state.go("recipes");
    },
  });
  goBtn.disabled = true;

  const back = Button({ label: "Back", intent: "ghost", onClick: () => state.go("mode") });

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap: var(--space-3); justify-content:center; margin-top: var(--space-5);";
  actions.append(goBtn, back);

  let rec, chunks = [], stream = null;
  mic.addEventListener("click", async () => {
    if (mic.classList.contains("recording")) {
      rec.stop();
      mic.classList.remove("recording");
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream);
      chunks = [];
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        stream.getTracks().forEach(t => t.stop());
        const res = await api.transcribe(blob);
        transcript.textContent = res.text || "(nothing heard)";
        // naive ingredient extraction: split on commas and `and`
        detected = (res.text || "").split(/,| and /).map(s => s.trim()).filter(Boolean);
        ingredientsList.innerHTML = "";
        for (const d of detected) ingredientsList.append(Chip({ label: d, variant: "sage" }));
        goBtn.disabled = detected.length === 0;
      };
      rec.start();
      mic.classList.add("recording");
    }
  });

  const voiceWrap = document.createElement("div");
  voiceWrap.className = "voice-area";
  voiceWrap.append(mic, transcript, ingredientsList);

  const wrap = document.createElement("div");
  wrap.append(eyebrow, h2, sub, Bezel({ children: [voiceWrap] }), actions);
  root.append(wrap);
  enter(wrap);
}
