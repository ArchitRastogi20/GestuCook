// frontend/static/js/api.js
// Minimal fetch wrappers. No retry, no auth. Backend errors bubble.

const BASE = "/api";

async function jsonPost(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function jsonGet(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

export const api = {
  // existing endpoints (unchanged)
  detectIngredients(files, cuisine) {
    const fd = new FormData();
    for (const f of files) fd.append("images", f);
    if (cuisine) fd.append("cuisine", cuisine);
    return fetch(`${BASE}/detect`, { method: "POST", body: fd }).then(r => r.json());
  },
  generateRecipes(ingredients, cuisine) {
    return jsonPost("/recipes", { ingredients, cuisine });
  },
  transcribe(blob) {
    const fd = new FormData();
    fd.append("audio", blob, "audio.webm");
    return fetch(`${BASE}/asr`, { method: "POST", body: fd }).then(r => r.json());
  },
  speak(text) {
    const fd = new FormData();
    fd.append("text", text);
    return fetch(`${BASE}/tts`, { method: "POST", body: fd }).then(r => r.blob());
  },
  costSnapshot() { return jsonGet("/config"); },

  // new session endpoints
  session: {
    start(name)                  { return jsonPost("/session/start", { name }); },
    event(session_id, kind, data){ return jsonPost("/session/event", { session_id, kind, data }); },
    end(payload)                 { return jsonPost("/session/end", payload); },
    history(name, limit = 10)    { return jsonGet(`/session/history?name=${encodeURIComponent(name)}&limit=${limit}`); },
    prefs(name, preferences)     { return jsonPost("/session/prefs", { name, preferences }); },
    trainerCompleted(name)       { return jsonPost("/session/trainer-completed", { name }); },
  },

  // new Q&A endpoint (used by feature 3)
  qa(payload) { return jsonPost("/qa", payload); },
};
