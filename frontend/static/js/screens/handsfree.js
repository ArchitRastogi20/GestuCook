// frontend/static/js/screens/handsfree.js
import { Bezel, Eyebrow, Button, Chip, setLoading, RequestStatus } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { enter } from "../ui/motion.js";
import { svg, ICONS } from "../ui/icons.js";
import { t } from "../i18n.js";

export function mount(root) {
  root.innerHTML = "";

  const eyebrow = Eyebrow({ text: t("hf.eyebrow") });

  const h2 = document.createElement("h2");
  h2.className = "t-display-l";
  h2.style.cssText = "text-align:center; margin-bottom: var(--space-3);";
  h2.innerHTML = t("hf.heading");

  const sub = document.createElement("p");
  sub.className = "t-body";
  sub.style.cssText = "text-align:center; margin: 0 auto var(--space-6);";
  sub.textContent = t("hf.sub");

  const mic = document.createElement("button");
  mic.className = "mic-btn";
  mic.append(svg(ICONS.mic, { size: 32, stroke: 1.5 }));

  const transcript = document.createElement("div");
  transcript.className = "voice-transcript";
  transcript.textContent = t("hf.idle");

  const ingredientsList = document.createElement("div");
  ingredientsList.className = "ingredients-list";

  let detected = [];

  const chipGroup = document.createElement("div");
  chipGroup.className = "chip-group";
  let selectedCuisine = null;
  // Labels localize; the value sent to the backend stays the English name.
  for (const c of ["Italian", "Indian", "Chinese", "American", "Turkish", "Any"]) {
    const chip = Chip({ label: t(`cuisine.${c}`) });
    chip.dataset.cuisine = c;
    chip.style.cursor = "pointer";
    chip.addEventListener("click", () => {
      for (const k of chipGroup.querySelectorAll(".chip")) k.classList.remove("on");
      chip.classList.add("on");
      selectedCuisine = c === "Any" ? null : c;
    });
    chipGroup.append(chip);
  }

  const reqStatus = RequestStatus();

  const goBtn = Button({
    label: t("hf.generate"),
    trailingIcon: "arrowRight",
    onClick: async () => {
      if (!detected.length || goBtn.disabled) return;
      setLoading(goBtn, true, t("photo.generating"));
      reqStatus.send(t("hf.sentTitle"), t("hf.sentSub"));
      try {
        const recipes = await api.generateRecipes(detected, selectedCuisine, state.language);
        state.setRecipes(recipes.recipes || recipes);
        state.go("recipes");
      } catch (e) {
        setLoading(goBtn, false);
        reqStatus.fail(t("photo.failedTitle"), t("hf.failedSub"));
      }
    },
  });
  goBtn.disabled = true;

  const back = Button({ label: t("common.back"), intent: "ghost", onClick: () => state.go("mode") });

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
        const res = await api.transcribe(blob, "ingredients", state.language);
        transcript.textContent = res.text || t("hf.nothing");
        // naive ingredient extraction: split on commas and the localized "and"
        detected = (res.text || "").split(/,| and | और | e | y /).map(s => s.trim()).filter(Boolean);
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
  wrap.append(eyebrow, h2, sub, Bezel({ children: [voiceWrap] }), chipGroup, actions, reqStatus.el);
  root.append(wrap);
  enter(wrap);
}
