// frontend/static/js/state.js
// Single source of truth for app-level state. Screens subscribe via on().

const SCREENS = [
  "welcome", "mode", "photo", "handsfree",
  "recipes", "cooking", "ambient", "trainer", "epilogue"
];

export class State {
  constructor() {
    this.screen = "welcome";
    this.session_id = null;
    this.user = this._loadUser();
    this.recipes = [];
    this.recipe_index = 0;
    this.step_index = 0;
    this.locked_step = false;       // sticky-step
    this.idle = false;              // auto-pause flag
    this.mode = "single";           // "single" | "parallel-2"
    this.cost = { usd: 0, in: 0, out: 0 };
    this._listeners = new Map();
  }

  _loadUser() {
    const name = localStorage.getItem("gestucook.name");
    return name ? { name } : null;
  }

  setUser(user) {
    this.user = user;
    if (user?.name) localStorage.setItem("gestucook.name", user.name);
    this.emit("user", user);
  }
  clearUser() {
    this.user = null;
    localStorage.removeItem("gestucook.name");
    this.emit("user", null);
  }

  setSession(id) { this.session_id = id; this.emit("session", id); }

  go(screen) {
    if (!SCREENS.includes(screen)) throw new Error(`Unknown screen ${screen}`);
    this.screen = screen;
    this.emit("screen", screen);
  }

  setRecipes(r) { this.recipes = r; this.recipe_index = 0; this.emit("recipes", r); }
  selectRecipe(i) { this.recipe_index = i; this.step_index = 0; this.emit("recipe-selected", this.recipes[i]); }
  nextStep() { this.step_index = Math.min(this.step_index + 1, this._steps().length - 1); this.emit("step", this.step_index); }
  prevStep() { this.step_index = Math.max(this.step_index - 1, 0); this.emit("step", this.step_index); }
  _steps() { return this.recipes[this.recipe_index]?.steps || []; }

  setLocked(v) { this.locked_step = !!v; this.emit("locked", v); }
  setIdle(v) { this.idle = !!v; this.emit("idle", v); }

  addCost(delta) {
    this.cost.usd += delta.usd || 0;
    this.cost.in  += delta.in  || 0;
    this.cost.out += delta.out || 0;
    this.emit("cost", this.cost);
  }

  resetCost() {
    this.cost = { usd: 0, in: 0, out: 0 };
    this.emit("cost", this.cost);
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
  }
  emit(event, payload) {
    const arr = this._listeners.get(event) || [];
    for (const fn of arr) fn(payload);
  }
}

export const state = new State();
