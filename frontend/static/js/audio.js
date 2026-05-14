// frontend/static/js/audio.js
// One TTS clip at a time. Timer fires Web Audio chime + callback.

import { api } from "./api.js";

export class TTSQueue {
  constructor({ fetcher = api.speak } = {}) {
    this.fetcher = fetcher;
    this.queue = [];
    this.playing = null;
    this.audio = null;
    this.inFlight = false;
  }

  get size() { return this.queue.length; }

  async enqueue(text) {
    this.queue.push(text);
    if (!this.playing) this._next();
  }

  stopAll() {
    this.queue = [];
    if (this.audio) { this.audio.pause(); this.audio.src = ""; }
    this.playing = null;
  }

  async _next() {
    const text = this.queue.shift();
    if (!text) { this.playing = null; return; }
    this.playing = text;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const blob = await this.fetcher(text);
      const url = URL.createObjectURL(blob);
      this.audio = new Audio(url);
      this.audio.onended = () => { URL.revokeObjectURL(url); this.inFlight = false; this._next(); };
      this.audio.onerror = () => { URL.revokeObjectURL(url); this.inFlight = false; this._next(); };
      this.audio.play();
    } catch (e) {
      this.inFlight = false;
      this._next();
    }
  }
}

export class Timer {
  constructor({ seconds, onTick = () => {}, onDone = () => {} }) {
    this.total = seconds;
    this.remaining = seconds;
    this.onTick = onTick;
    this.onDone = onDone;
    this._handle = null;
    this._pausedAt = null;
  }
  start() {
    this._handle = setInterval(() => {
      this.remaining = Math.max(0, this.remaining - 1);
      this.onTick(this.remaining);
      if (this.remaining <= 0) { this.stop(); chime(); this.onDone(); }
    }, 1000);
  }
  pause() {
    if (this._handle) { clearInterval(this._handle); this._handle = null; this._pausedAt = Date.now(); }
  }
  resume() {
    if (this._pausedAt) { this._pausedAt = null; this.start(); }
  }
  stop() { if (this._handle) { clearInterval(this._handle); this._handle = null; } }
}

function chime() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.value = 880;
  g.gain.value = 0.0;
  o.connect(g); g.connect(ctx.destination);
  o.start();
  g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02);
  g.gain.linearRampToValueAtTime(0.0,  ctx.currentTime + 0.4);
  o.stop(ctx.currentTime + 0.5);
}

export { chime };
