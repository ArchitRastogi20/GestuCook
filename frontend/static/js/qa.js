// frontend/static/js/qa.js
// Gesture-gated live Q&A. The peace sign (or the "question" voice command)
// opens a single, fixed listening window: an earcon sounds, the user speaks
// one question, it is transcribed and answered aloud, and the session then
// closes on its own. Shared by the cooking and ambient screens so the flow is
// identical in both.
//
// Why gated: the old design captured every utterance and shipped anything
// 2+ words long to the LLM, which fired stray answers constantly. A question
// now needs a deliberate trigger.

import { api } from "./api.js";
import { tts, chime } from "./audio.js";
import { state } from "./state.js";
import { looksLikeQuestion } from "./voice.js";

let active = false;

// Screens read this to suppress navigation while a question is in flight.
export function qaActive() { return active; }

// Run one Q&A session.
//   voice:     the screen's VoiceLoop (supplies captureQuestion)
//   getRecipe: () => the current recipe object
//   getStep:   () => the current step index
//   overlay:   a QaOverlay controller (drives the on-screen state)
//   listenMs:  capture-window length (default 5.5 s -> the "3-5 s to speak")
export async function runQaSession({ voice, getRecipe, getStep, overlay, listenMs = 5500 }) {
  if (active) return;

  // Master toggle: the feature is switched off on the cooking / recipes screen.
  if (!state.voiceQA) {
    tts.enqueue("Voice Q and A is off. Switch it on to ask a question.");
    return;
  }
  if (!voice || typeof voice.captureQuestion !== "function") return;

  active = true;
  try {
    tts.stopAll();
    try { chime(); } catch {}              // earcon: the listening window is open
    overlay && overlay.listening(listenMs);

    const question = await voice.captureQuestion(listenMs);
    if (!looksLikeQuestion(question)) {
      overlay && overlay.error("Didn't catch that");
      tts.enqueue("Sorry, I didn't catch that. Make the peace sign to try again.");
      return;
    }

    const recipe = getRecipe ? getRecipe() : null;
    if (!recipe) {
      overlay && overlay.error("No recipe loaded");
      return;
    }
    overlay && overlay.thinking(question);

    const res = await api.qa({
      session_id: state.session_id,
      current_recipe: recipe,
      current_step_index: getStep ? getStep() : 0,
      question,
    });
    state.addCost({ usd: res.cost_delta_usd, in: res.tokens_in, out: res.tokens_out });
    state._qaCount = (state._qaCount || 0) + 1;
    overlay && overlay.answer(res.answer);
    tts.enqueue(res.answer);
  } catch {
    overlay && overlay.error("Couldn't answer that");
    tts.enqueue("Sorry, I couldn't answer that.");
  } finally {
    // Live Q&A disarms automatically -- the next peace sign starts a new one.
    active = false;
  }
}
