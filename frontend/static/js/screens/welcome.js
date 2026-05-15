// frontend/static/js/screens/welcome.js
import { Bezel, Button, Eyebrow } from "../ui/components.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { enter } from "../ui/motion.js";

export function mount(root) {
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "welcome-wrap";

  const eyebrow = Eyebrow({ text: state.user ? `welcome back ${state.user.name}` : "welcome" });

  const heading = document.createElement("h1");
  heading.innerHTML = state.user
    ? `Pick up where you <span class="italic">left off</span>.`
    : `Cook with your <span class="italic">hands</span>.`;

  const lede = document.createElement("p");
  lede.textContent = state.user
    ? "Same name? Continue. Otherwise change it."
    : "Tell us your name, then choose how you want to start. Voice or photo, either works.";

  const input = document.createElement("input");
  input.className = "welcome-input";
  input.placeholder = "your name";
  input.value = state.user?.name || "";
  input.autocomplete = "off";

  const startBtn = Button({
    label: state.user ? "Continue" : "Get started",
    trailingIcon: "arrowRight",
    onClick: () => onStart(),
  });

  let switchUserLink = null;
  if (state.user) {
    switchUserLink = document.createElement("a");
    switchUserLink.textContent = "not you?";
    switchUserLink.style.cssText = "color: var(--ink-3); font-size: 13px; cursor: pointer; text-decoration: underline;";
    switchUserLink.onclick = () => { state.clearUser(); input.value = ""; input.focus(); mount(root); };
  }

  const actions = document.createElement("div");
  actions.className = "welcome-actions";
  actions.append(startBtn);
  if (switchUserLink) actions.append(switchUserLink);

  const bezel = Bezel({ children: [eyebrow, heading, lede, input, actions] });
  wrap.append(bezel);
  root.append(wrap);
  enter(wrap);

  async function onStart() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      const { session_id, user } = await api.session.start(name);
      state.setUser(user);
      state.setSession(session_id);
      state.go("mode");
    } catch (e) {
      console.error(e);
      // graceful: still proceed so the demo works without Mongo
      state.setUser({ name });
      state.go("mode");
    }
  }
}
