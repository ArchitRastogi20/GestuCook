// frontend/static/js/voice.js
// Always-on small ASR loop for VOICE COMMANDS. Captures 3-second chunks and
// matches a tiny command grammar (next, back, pause, ...). Anything that is not
// a command is ignored -- spoken QUESTIONS are no longer captured here.
//
// Questions are gesture-gated: the peace sign opens a fixed listening window
// (see qa.js), and that window is recorded by captureQuestion() below. This
// removes the old always-on behaviour where any stray utterance was shipped to
// the LLM as a question.
//
// Public:
//   const v = new VoiceLoop({ onCommand(action, raw) {} })
//   v.start(); v.stop();
//   const text = await v.captureQuestion(5500)   // one-shot, for a Q&A window

import { api } from "./api.js";
import { state } from "./state.js";

const GRAMMAR = [
  { action: "next",            patterns: [/^(next|next step|forward|continue|after this)$/i] },
  { action: "back",            patterns: [/^(back|previous|go back|previous step)$/i] },
  { action: "repeat",          patterns: [/^(repeat|again|read (it )?again)$/i] },
  { action: "pause",           patterns: [/^(pause|stop|hold on)$/i] },
  { action: "resume",          patterns: [/^(resume|continue|keep going)$/i] },
  { action: "ask",             patterns: [/^(question|i have a question|ask|ask a question|hey chef)$/i] },
  { action: "ambient_enter",   patterns: [/^(kitchen mode|ambient|ambient mode|big mode)$/i] },
  { action: "ambient_exit",    patterns: [/^(normal mode|exit kitchen|back to normal|small mode)$/i] },
  { action: "trainer",         patterns: [/^(train|practice|practice gestures|gesture trainer)$/i] },
  { action: "save_moment",     patterns: [/^(save this|snapshot|moment|capture)$/i] },
];

// Localized command words, merged with the English GRAMMAR: both always work.
const GRAMMAR_LOCALIZED = {
  hi: [
    { action: "next",          patterns: [/^(अगला|आगे|अगला स्टेप|आगे बढ़ो)$/] },
    { action: "back",          patterns: [/^(पीछे|वापस|पिछला)$/] },
    { action: "repeat",        patterns: [/^(दोहराओ|फिर से|दोबारा)$/] },
    { action: "pause",         patterns: [/^(रुको|रोको|ठहरो)$/] },
    { action: "resume",        patterns: [/^(जारी रखो|चालू करो|आगे चलो)$/] },
    { action: "ask",           patterns: [/^(सवाल|प्रश्न|मुझे सवाल पूछना है)$/] },
    { action: "ambient_enter", patterns: [/^(किचन मोड|बड़ा मोड)$/] },
    { action: "ambient_exit",  patterns: [/^(सामान्य मोड|किचन से बाहर)$/] },
    { action: "trainer",       patterns: [/^(अभ्यास|ट्रेनर|इशारे सिखाओ)$/] },
    { action: "save_moment",   patterns: [/^(सेव करो|स्नैपशॉट|यह सेव करो)$/] },
  ],
  it: [
    { action: "next",          patterns: [/^(avanti|prossimo|prossimo passo)$/i] },
    { action: "back",          patterns: [/^(indietro|precedente|torna indietro)$/i] },
    { action: "repeat",        patterns: [/^(ripeti|ancora|di nuovo)$/i] },
    { action: "pause",         patterns: [/^(pausa|fermati|aspetta)$/i] },
    { action: "resume",        patterns: [/^(riprendi|continua)$/i] },
    { action: "ask",           patterns: [/^(domanda|ho una domanda)$/i] },
    { action: "ambient_enter", patterns: [/^(modalità cucina|schermo grande)$/i] },
    { action: "ambient_exit",  patterns: [/^(modalità normale|schermo piccolo)$/i] },
    { action: "trainer",       patterns: [/^(allenamento|gesti|allena i gesti)$/i] },
    { action: "save_moment",   patterns: [/^(salva|salva questo|istantanea)$/i] },
  ],
  es: [
    { action: "next",          patterns: [/^(siguiente|adelante|siguiente paso)$/i] },
    { action: "back",          patterns: [/^(atrás|anterior|vuelve)$/i] },
    { action: "repeat",        patterns: [/^(repite|otra vez|de nuevo)$/i] },
    { action: "pause",         patterns: [/^(pausa|para|espera)$/i] },
    { action: "resume",        patterns: [/^(continúa|sigue|reanuda)$/i] },
    { action: "ask",           patterns: [/^(pregunta|tengo una pregunta)$/i] },
    { action: "ambient_enter", patterns: [/^(modo cocina|pantalla grande)$/i] },
    { action: "ambient_exit",  patterns: [/^(modo normal|pantalla pequeña)$/i] },
    { action: "trainer",       patterns: [/^(entrenamiento|gestos|practicar gestos)$/i] },
    { action: "save_moment",   patterns: [/^(guarda|guarda esto|captura)$/i] },
  ],
};

export function matchCommand(raw, lang = state.language) {
  if (!raw) return null;
  const text = raw.toLowerCase()
    .replace(/^(uhh|um|hmm|so)\s+/, "")
    .replace(/[.,!?।]+$/u, "")        // Whisper appends punctuation; "अगला।" must match "अगला"
    .trim();
  for (const g of GRAMMAR) for (const p of g.patterns) if (p.test(text)) return { action: g.action, raw };
  for (const g of GRAMMAR_LOCALIZED[lang] || []) {
    for (const p of g.patterns) if (p.test(text)) return { action: g.action, raw };
  }
  return null;
}

// A plausible spoken question needs at least two words -- single-token ASR
// noise (Whisper transcribes silence as stray words) should not reach the LLM.
export function looksLikeQuestion(raw) {
  const words = (raw || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  return words.length >= 2;
}

export class VoiceLoop {
  constructor({ onCommand, chunkMs = 3000 } = {}) {
    this.onCommand   = onCommand || (() => {});
    this.chunkMs     = chunkMs;
    this.running     = false;
    this.muted       = false;   // muted while TTS plays (poll-based, re-checked every 200ms)
    this._capturing  = false;   // a Q&A capture owns the mic; the loop must not record
    this._stream     = null;
    this._rec        = null;
  }
  mute()   { this.muted = true; }
  unmute() { this.muted = false; }

  async start() {
    if (this.running) return;
    this.running = true;
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this._tick();
  }
  stop() {
    this.running = false;
    if (this._rec && this._rec.state !== "inactive") this._rec.stop();
    if (this._stream) this._stream.getTracks().forEach(t => t.stop());
    this._stream = null; this._rec = null;
  }
  async _tick() {
    if (!this.running) return;
    // A Q&A capture owns the mic -- it restarts the loop itself when it ends,
    // so we do NOT re-poll here (unlike the TTS mute below).
    if (this._capturing) return;
    if (this.muted) { setTimeout(() => this._tick(), 200); return; }
    const chunks = [];
    this._rec = new MediaRecorder(this._stream);
    this._rec.ondataavailable = e => chunks.push(e.data);
    this._rec.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      try {
        const res = await api.transcribe(blob, undefined, state.language);
        const text = (res?.text || "").trim();
        // Commands only. A non-command utterance is ignored -- questions are
        // captured by captureQuestion() during a gesture-gated Q&A window.
        if (text) {
          const cmd = matchCommand(text);
          if (cmd) this.onCommand(cmd.action, text);
        }
      } catch {}
      if (this.running) this._tick();
    };
    this._rec.start();
    setTimeout(() => { if (this._rec && this._rec.state === "recording") this._rec.stop(); }, this.chunkMs);
  }

  // One-shot capture for a live Q&A window. Records a single `ms`-long blob
  // from the already-granted microphone stream and returns the transcription.
  //
  // The `_capturing` flag (not the TTS `muted` flag) gates the command loop:
  // `muted` is driven asynchronously by TTS playback callbacks and could flip
  // mid-window, so it cannot be trusted to bracket a capture. `_capturing` is
  // owned solely here and the loop is restarted explicitly when we are done.
  async captureQuestion(ms = 5500) {
    if (!this._stream) return "";
    this._capturing = true;
    // Stop the loop's in-flight recorder so ours is the only one on the stream.
    if (this._rec && this._rec.state === "recording") {
      try { this._rec.stop(); } catch {}
    }
    await new Promise(r => setTimeout(r, 150));   // let the loop recorder settle

    const chunks = [];
    let rec;
    try {
      rec = new MediaRecorder(this._stream);
    } catch {
      this._capturing = false;
      if (this.running) this._tick();
      return "";
    }
    this._rec = rec;                              // so stop() can tear this down too
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start();
    await new Promise(r => setTimeout(r, ms));
    if (rec.state !== "inactive") { try { rec.stop(); } catch {} }
    await stopped;

    this._capturing = false;
    if (this.running) this._tick();               // explicitly resume the command loop

    if (!chunks.length) return "";
    const blob = new Blob(chunks, { type: "audio/webm" });
    try {
      const res = await api.transcribe(blob, undefined, state.language);
      return (res?.text || "").trim();
    } catch {
      return "";
    }
  }
}
