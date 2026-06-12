// frontend/static/js/screens/epilogue.js
import { Eyebrow, Button, Skeleton } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { tts } from "../audio.js";
import { enter } from "../ui/motion.js";
import { loadMoments } from "../moments.js";
import { t } from "../i18n.js";

// Placeholder layout shown while the session summary + moments load.
function buildSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "epilogue-wrap";
  const centred = (node, mb) => { node.style.margin = `0 auto ${mb}`; return node; };
  wrap.append(
    centred(Skeleton({ width: "170px", height: "13px", radius: "var(--r-pill)" }), "var(--space-5)"),
    centred(Skeleton({ width: "min(440px, 82%)", height: "46px", radius: "12px" }), "var(--space-4)"),
    centred(Skeleton({ width: "min(360px, 72%)", height: "18px", radius: "6px" }), "var(--space-6)"),
  );
  const sheet = document.createElement("div");
  sheet.className = "epilogue-sheet";
  for (let i = 0; i < 4; i++) sheet.append(Skeleton({ height: "118px", radius: "var(--r-sm)" }));
  wrap.append(sheet);
  return wrap;
}

export async function mount(root) {
  root.innerHTML = "";
  root.append(buildSkeleton());   // shimmer while the async work below runs

  const r = state.recipes[state.recipe_index];
  const startedAt = state._epStartedAt || (state._epStartedAt = Date.now() - 60000);
  const durationMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  const recipeTitle = r?.name || t("ep.fallbackDish");
  const ingredientsCount = (r?.ingredients || []).length;
  const costCents = Math.round((state.cost.usd || 0) * 100);

  let monthCount = 1;
  if (state.user?.name) {
    const historyP = api.session.history(state.user.name, 1).catch(() => null);
    const endP = state.session_id ? api.session.end({
      session_id: state.session_id,
      recipe_title: recipeTitle,
      total_cost_usd: state.cost.usd,
      tokens_in: state.cost.in,
      tokens_out: state.cost.out,
      completed_steps: (r?.steps?.length) || 0,
      total_steps:    (r?.steps?.length) || 0,
      voice_qa_count: state._qaCount || 0,
      moments_count:  state._momentsCount || 0,
      mode: state.mode,
    }).catch(() => null) : Promise.resolve(null);

    const [h] = await Promise.all([historyP, endP]);
    monthCount = h?.totals?.month_count || 1;
  }

  const eyebrow = Eyebrow({ text: t("ep.eyebrow") });
  eyebrow.classList.add("epilogue-eyebrow");

  const h1 = document.createElement("h1");
  h1.className = "epilogue-h1";
  h1.innerHTML = t("ep.heading", { title: recipeTitle });

  const stat = document.createElement("p");
  stat.className = "epilogue-stat";
  stat.innerHTML = t("ep.stat", {
    min: durationMin, ing: ingredientsCount, c: costCents.toFixed(1), m: monthCount,
    recipes: t(monthCount === 1 ? "ep.recipeOne" : "ep.recipeMany"),
  });

  const sheet = document.createElement("div");
  sheet.className = "epilogue-sheet";
  const m = await loadMoments(state.session_id);
  for (const e of m) {
    const cell = document.createElement("div"); cell.className = "frame";
    const img = document.createElement("img"); img.src = URL.createObjectURL(e.blob);
    const cap = document.createElement("div"); cap.className = "caption"; cap.textContent = t("ep.caption", { n: e.step_num });
    cell.append(img, cap); sheet.append(cell);
  }

  const cta = document.createElement("div");
  cta.style.cssText = "display:flex; gap: var(--space-3); justify-content:center; margin-top: var(--space-6);";
  cta.append(
    Button({ label: t("ep.cookAnother"), trailingIcon: "arrowRight", onClick: () => { state.resetCost(); state.go("mode"); } }),
  );

  const wrap = document.createElement("div");
  wrap.className = "epilogue-wrap";
  wrap.append(eyebrow, h1, stat, sheet, cta);
  root.replaceChildren(wrap);
  enter(wrap);

  tts.enqueue(t("ep.tts", {
    title: recipeTitle, min: durationMin, ing: ingredientsCount, c: costCents.toFixed(0), m: monthCount,
    recipes: t(monthCount === 1 ? "ep.recipeOne" : "ep.recipeMany"),
  }));
}

export function unmount() { tts.stopAll(); }
