// frontend/static/js/screens/welcome.js
import { Bezel, Button, Eyebrow, Chip } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { enter } from "../ui/motion.js";
import { t, LANGUAGES } from "../i18n.js";

export function mount(root) {
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "welcome-wrap";

  const eyebrow = Eyebrow({ text: state.user ? t("welcome.back", { name: state.user.name }) : t("welcome.eyebrow") });

  const heading = document.createElement("h1");
  heading.innerHTML = state.user
    ? t("welcome.heading.returning")
    : t("welcome.heading.new");

  const lede = document.createElement("p");
  lede.textContent = state.user
    ? t("welcome.lede.returning")
    : t("welcome.lede.new");

  const input = document.createElement("input");
  input.className = "welcome-input";
  input.placeholder = t("welcome.namePlaceholder");
  input.value = state.user?.name || "";
  input.autocomplete = "off";

  const startBtn = Button({
    label: state.user ? t("welcome.continue") : t("welcome.getStarted"),
    trailingIcon: "arrowRight",
    onClick: () => onStart(),
  });

  let switchUserLink = null;
  if (state.user) {
    switchUserLink = document.createElement("a");
    switchUserLink.textContent = t("welcome.notYou");
    switchUserLink.style.cssText = "color: var(--ink-3); font-size: 13px; cursor: pointer; text-decoration: underline;";
    switchUserLink.onclick = () => { state.clearUser(); input.value = ""; input.focus(); mount(root); };
  }

  // Language picker: selecting re-mounts this screen in the new language
  // (welcome is the sanctioned self-remount exception, like "not you?").
  const langRow = document.createElement("div");
  langRow.className = "chip-group";
  langRow.style.cssText = "justify-content:center; margin-top: var(--space-3);";
  const langLabel = document.createElement("span");
  langLabel.className = "t-eyebrow";
  langLabel.style.cssText = "color: var(--ink-3); margin-right: 6px; align-self:center;";
  langLabel.textContent = t("welcome.langLabel");
  langRow.append(langLabel);
  for (const l of LANGUAGES) {
    const chip = Chip({ label: l.label });
    chip.style.cursor = "pointer";
    if (l.code === state.language) chip.classList.add("on");
    chip.addEventListener("click", () => { state.setLanguage(l.code); mount(root); });
    langRow.append(chip);
  }

  const actions = document.createElement("div");
  actions.className = "welcome-actions";
  actions.append(startBtn);
  if (switchUserLink) actions.append(switchUserLink);

  const bezel = Bezel({ children: [eyebrow, heading, lede, input, langRow, actions] });
  wrap.append(bezel);
  root.append(wrap);
  enter(wrap);

  async function onStart() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    // first-run onboarding: new users practice the five gestures before cooking
    const next = localStorage.getItem("gestucook.trainerDone") ? "mode" : "trainer";
    try {
      const { session_id, user } = await api.session.start(name);
      state.setUser(user);
      state.setSession(session_id);
      state.go(next);
    } catch (e) {
      console.error(e);
      // graceful: still proceed so the demo works without Mongo
      state.setUser({ name });
      state.go(next);
    }
  }
}
