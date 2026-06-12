// frontend/static/js/screens/mode.js
import { Bezel, Eyebrow } from "../ui/components.js";
import { state } from "../state.js";
import { enter } from "../ui/motion.js";
import { svg, ICONS } from "../ui/icons.js";
import { t } from "../i18n.js";

export function mount(root) {
  root.innerHTML = "";

  const eyebrow = Eyebrow({ text: t("mode.eyebrow") });

  const h2 = document.createElement("h2");
  h2.className = "t-display-l";
  h2.style.textAlign = "center";
  h2.style.marginBottom = "var(--space-3)";
  h2.innerHTML = t("mode.heading");

  const sub = document.createElement("p");
  sub.className = "t-body";
  sub.style.textAlign = "center";
  sub.style.margin = "0 auto var(--space-6)";
  sub.textContent = t("mode.sub");

  const grid = document.createElement("div");
  grid.className = "mode-grid";

  grid.append(
    makeCard({ icon: ICONS.camera, title: t("mode.photo.title"), desc: t("mode.photo.desc"), goto: "photo" }),
    makeCard({ icon: ICONS.mic,    title: t("mode.handsfree.title"), desc: t("mode.handsfree.desc"), goto: "handsfree" }),
  );

  const wrap = document.createElement("div");
  wrap.style.cssText = "text-align: center;";
  wrap.append(eyebrow, h2, sub, grid);
  root.append(wrap);
  enter(wrap);

  function makeCard({ icon, title, desc, goto }) {
    const iconNode = svg(icon, { size: 36, stroke: 1.4 });
    iconNode.classList.add("mode-card-icon");
    const h = document.createElement("h3"); h.textContent = title;
    const p = document.createElement("p");  p.textContent = desc;
    const card = Bezel({ lift: true, children: [iconNode, h, p] });
    card.classList.add("mode-card");
    card.style.cursor = "pointer";
    card.addEventListener("click", () => state.go(goto));
    return card;
  }
}
