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
    this.epoch = 0;            // bumped by stopAll() to invalidate in-flight work
    this._listeners = new Set();
  }

  onPlayingChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emitPlaying(isPlaying) {
    for (const fn of this._listeners) fn(isPlaying);
  }

  get size() { return this.queue.length; }

  async enqueue(text) {
    if (!text) return;
    this.queue.push(text);
    if (!this.playing && !this.inFlight) this._next();
  }

  // Hard stop. Clears the queue, stops the current clip, AND invalidates any
  // clip whose audio is still being FETCHED: bumping `epoch` makes the
  // in-flight _next() discard its blob instead of playing it after the stop.
  // Without this, a clip requested just before a screen / step change keeps
  // playing on the next screen -- the overlapping-narration bug.
  stopAll() {
    this.epoch++;
    this.queue = [];
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      try { this.audio.pause(); } catch {}
      this.audio.src = "";
      this.audio = null;
    }
    this.playing = null;
    this.inFlight = false;
    this._emitPlaying(false);
  }

  async _next() {
    if (this.inFlight) return;       // another _next() is mid-fetch; will pick up after it ends
    const text = this.queue.shift();
    if (!text) { this.playing = null; return; }
    this.playing = text;
    this.inFlight = true;
    const myEpoch = this.epoch;
    try {
      const blob = await this.fetcher(text);
      if (myEpoch !== this.epoch) return;   // stopAll() ran while fetching -- discard, own nothing
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this.audio = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        if (myEpoch !== this.epoch) return; // a newer clip (or a stop) owns the queue now
        this.inFlight = false;
        this.playing = null;
        this._emitPlaying(false);
        this._next();
      };
      audio.onended = done;
      audio.onerror = done;
      this._emitPlaying(true);
      audio.play();
    } catch (e) {
      if (myEpoch !== this.epoch) return;
      this.inFlight = false;
      this.playing = null;
      this._emitPlaying(false);
      this._next();
    }
  }
}

// One shared queue for the WHOLE app. Every screen imports this same instance,
// so it is physically impossible for two clips to play at once.
export const tts = new TTSQueue();

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

let _ctx = null;
function getAudioCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

function chime() {
  const ctx = getAudioCtx();
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
