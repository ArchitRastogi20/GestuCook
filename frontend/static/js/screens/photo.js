// frontend/static/js/screens/photo.js
import { Bezel, Eyebrow, Button, Chip, setLoading, RequestStatus } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { enter } from "../ui/motion.js";
import { svg, ICONS } from "../ui/icons.js";
import { t } from "../i18n.js";

export function mount(root) {
  root.innerHTML = "";

  const eyebrow = Eyebrow({ text: t("photo.eyebrow") });
  const h2 = document.createElement("h2");
  h2.className = "t-display-l";
  h2.style.cssText = "text-align:center; margin-bottom: var(--space-3);";
  h2.innerHTML = t("photo.heading");

  const sub = document.createElement("p");
  sub.className = "t-body";
  sub.style.cssText = "text-align:center; margin: 0 auto var(--space-6);";
  sub.textContent = t("photo.sub");

  const zoneInner = document.createElement("div");
  zoneInner.className = "upload-zone";
  const ic = svg(ICONS.camera, { size: 36, stroke: 1.4 }); ic.classList.add("icon");
  const lbl = document.createElement("p"); lbl.textContent = t("photo.dropzone");
  zoneInner.append(ic, lbl);
  const zone = Bezel({ children: [zoneInner] });

  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.multiple = true; fileInput.accept = ".jpg,.jpeg,.png";
  fileInput.style.display = "none";

  const thumbs = document.createElement("div"); thumbs.className = "thumb-strip";

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

  let files = [];
  const detectBtn = Button({
    label: t("photo.detect"),
    trailingIcon: "arrowRight",
    onClick: async () => {
      if (!files.length || detectBtn.disabled) return;
      setLoading(detectBtn, true, t("photo.detecting"));
      reqStatus.send(t("common.requestSent"), t("photo.sentSub"));
      try {
        const det = await api.detectIngredients(files, selectedCuisine);
        if (!det.ingredients.length) {
          setLoading(detectBtn, false);
          reqStatus.fail(t("photo.nothingTitle"), t("photo.nothingSub"));
          return;
        }
        setLoading(detectBtn, true, t("photo.generating"));
        reqStatus.update(t("photo.foundSub", { n: det.ingredients.length }));
        const recipes = await api.generateRecipes(det.ingredients, selectedCuisine, state.language);
        state.setRecipes(recipes.recipes || recipes);
        state.go("recipes");
      } catch (e) {
        setLoading(detectBtn, false);
        reqStatus.fail(t("photo.failedTitle"), t("photo.failedSub"));
      }
    },
  });
  detectBtn.disabled = true;

  const back = Button({ label: t("common.back"), intent: "ghost", onClick: () => state.go("mode") });

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap: var(--space-3); justify-content:center; margin-top: var(--space-5);";
  actions.append(detectBtn, back);

  zone.addEventListener("click", () => fileInput.click());
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.querySelector(".upload-zone").classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.querySelector(".upload-zone").classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.querySelector(".upload-zone").classList.remove("dragover");
    handle([...e.dataTransfer.files]);
  });
  fileInput.addEventListener("change", (e) => handle([...e.target.files]));

  function handle(list) {
    files = list;
    thumbs.innerHTML = "";
    for (const f of list) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      thumbs.append(img);
    }
    detectBtn.disabled = list.length === 0;
  }

  const wrap = document.createElement("div");
  wrap.append(eyebrow, h2, sub, zone, fileInput, thumbs, document.createTextNode(""), chipGroup, actions, reqStatus.el);
  root.append(wrap);
  enter(wrap);
}
