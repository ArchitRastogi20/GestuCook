// frontend/static/js/voice.js
// Always-on small ASR loop. Captures 3-second chunks, matches a tiny grammar.
//
// Public:
//   const v = new VoiceLoop({ onCommand(action, raw) {}, onQA(question){} })
//   v.start(); v.stop();

import { api } from "./api.js";

const GRAMMAR = [
  { action: "next",            patterns: [/^(next|next step|forward|continue|after this)$/i] },
  { action: "back",            patterns: [/^(back|previous|go back|previous step)$/i] },
  { action: "repeat",          patterns: [/^(repeat|again|read (it )?again)$/i] },
  { action: "pause",           patterns: [/^(pause|stop|hold on)$/i] },
  { action: "resume",          patterns: [/^(resume|continue|keep going)$/i] },
  { action: "ambient_enter",   patterns: [/^(kitchen mode|ambient|ambient mode|big mode)$/i] },
  { action: "ambient_exit",    patterns: [/^(normal mode|exit kitchen|back to normal|small mode)$/i] },
  { action: "trainer",         patterns: [/^(train|practice|practice gestures|gesture trainer)$/i] },
  { action: "save_moment",     patterns: [/^(save this|snapshot|moment|capture)$/i] },
];

const QA_PREFIX = /^(hey\s*gestu|hey\s*gesture|ok\s*gestu)[\s,]*(.+)$/i;

export function matchCommand(raw) {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/^(uhh|um|hmm|so)\s+/, "").trim();
  for (const g of GRAMMAR) for (const p of g.patterns) if (p.test(text)) return { action: g.action, raw };
  return null;
}

export function matchQA(raw) {
  if (!raw) return null;
  const m = raw.match(QA_PREFIX);
  if (!m) return null;
  return { question: m[2].trim(), raw };
}

export class VoiceLoop {
  constructor({ onCommand, onQA, chunkMs = 3000 } = {}) {
    this.onCommand = onCommand || (() => {});
    this.onQA      = onQA      || (() => {});
    this.chunkMs   = chunkMs;
    this.running   = false;
    this.muted     = false;   // muted while TTS plays
    this._stream   = null;
    this._rec      = null;
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
    if (this.muted) { setTimeout(() => this._tick(), 200); return; }
    const chunks = [];
    this._rec = new MediaRecorder(this._stream);
    this._rec.ondataavailable = e => chunks.push(e.data);
    this._rec.onstop = async () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      try {
        const res = await api.transcribe(blob);
        const text = (res?.text || "").trim();
        if (text) {
          const qa = matchQA(text);
          if (qa) this.onQA(qa.question, text);
          else {
            const cmd = matchCommand(text);
            if (cmd) this.onCommand(cmd.action, text);
          }
        }
      } catch {}
      if (this.running) this._tick();
    };
    this._rec.start();
    setTimeout(() => { if (this._rec && this._rec.state === "recording") this._rec.stop(); }, this.chunkMs);
  }
}
