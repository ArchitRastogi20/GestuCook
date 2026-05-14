// frontend/static/js/gestures.js
// Hybrid pipeline:
//   - MediaPipe Tasks Vision GestureRecognizer for static pose classification
//   - Custom wrist-trajectory layer for swipes
//
// onGesture(name) names: thumbs_up, fist, open_palm, pointing_up, victory,
//                        swipe_left, swipe_right, idle (no-hand)

import { FilesetResolver, GestureRecognizer } from "/static/vendor/mediapipe/vision_bundle.mjs";

const DEFAULTS = {
  confidence: {
    Thumb_Up:   0.85,
    Closed_Fist:0.85,
    Open_Palm:  0.75,
    Pointing_Up:0.80,
    Victory:    0.80,
  },
  confirmFrames: {
    Thumb_Up:   8,
    Closed_Fist:8,
    Open_Palm:  5,
    Pointing_Up:6,
    Victory:    6,
  },
  cooldownMs:    1600,
  palmCooldownMs:600,
  idleMs:        3000,
  swipeWindow:   20,
  swipeThreshold:0.18,
  swipeMinMs:    120,
  swipeMaxMs:    600,
};

const TO_ACTION = {
  Thumb_Up:    "thumbs_up",
  Closed_Fist: "fist",
  Open_Palm:   "open_palm",
  Pointing_Up: "pointing_up",
  Victory:     "victory",
};

export const GestureEngine = (() => {
  let recognizer = null;
  let onGesture = null;
  let videoEl = null;
  let canvasEl = null;
  let ctx = null;
  let running = false;
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));

  // confirm state
  let cand = null;
  let candCount = 0;
  let lastFireAt = 0;
  let lastFireClass = null;
  let lastSeenHandAt = 0;
  let idleEmitted = false;

  // swipe state
  let wristHistory = [];
  let swipeLocked = false;

  // ring buffer for diagnostics
  const ring = [];
  function diag(entry) { ring.push(entry); if (ring.length > 50) ring.shift(); }
  function getDiagnostics() { return ring.slice(); }

  async function init(video, canvas, callback) {
    videoEl = video; canvasEl = canvas; ctx = canvas.getContext("2d"); onGesture = callback;
    const vision = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
    recognizer = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "/static/vendor/mediapipe/gesture_recognizer.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence:  0.55,
      minTrackingConfidence:      0.50,
    });
  }

  async function start() {
    if (running || !recognizer) return;
    running = true; _reset();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
    videoEl.srcObject = stream;
    await videoEl.play();
    _loop();
  }

  function stop() {
    running = false;
    if (videoEl?.srcObject) videoEl.srcObject.getTracks().forEach(t => t.stop());
    _reset();
  }

  function _reset() {
    cand = null; candCount = 0; wristHistory = []; swipeLocked = false; idleEmitted = false;
  }

  async function _loop() {
    if (!running) return;
    const now = performance.now();
    if (videoEl.readyState >= 2) {
      const res = await recognizer.recognizeForVideo(videoEl, now);
      _tick(res, now);
    }
    requestAnimationFrame(_loop);
  }

  function _tick(res, now) {
    _drawLandmarks(res);
    const hasHand = !!(res.landmarks && res.landmarks[0]);

    // idle / auto-pause emission
    if (hasHand) {
      lastSeenHandAt = now;
      if (idleEmitted) { idleEmitted = false; }
    } else {
      if (!idleEmitted && now - lastSeenHandAt > cfg.idleMs && lastSeenHandAt > 0) {
        idleEmitted = true;
        onGesture && onGesture("idle");
      }
      _reset();
      return;
    }

    const cooldown = lastFireClass === "Open_Palm" ? cfg.palmCooldownMs : cfg.cooldownMs;
    if (now - lastFireAt < cooldown) return;

    const top = (res.gestures?.[0]?.[0]) || { categoryName: "None", score: 0 };
    const action = TO_ACTION[top.categoryName] ? top.categoryName : null;
    const floor  = action ? cfg.confidence[action] : 1.0;
    const passes = action && top.score >= floor;

    // swipe gating: only attempt if top is None or below floor
    if (!passes) {
      const wrist = res.landmarks?.[0]?.[0];
      if (wrist) _trackWrist(wrist.x, now);
      const swipe = _detectSwipe(now);
      if (swipe) { _fire(swipe, now, "swipe", top.score); return; }
    } else {
      // we have a confident static pose -- invalidate swipe attempts
      wristHistory = [];
    }

    // confirm-frame discipline
    if (passes) {
      if (cand === action) {
        candCount += 1;
      } else {
        cand = action; candCount = 1;
      }
      const needed = cfg.confirmFrames[action];
      if (candCount >= needed) {
        _fire(TO_ACTION[action], now, "static", top.score);
        cand = null; candCount = 0;
      }
    } else {
      cand = null; candCount = 0;
    }
  }

  function _fire(actionName, now, source, score) {
    lastFireAt = now;
    lastFireClass = Object.entries(TO_ACTION).find(([k, v]) => v === actionName)?.[0] || null;
    wristHistory = []; swipeLocked = true;
    diag({ ts: Date.now(), class: actionName, score, source });
    onGesture && onGesture(actionName);
  }

  function _trackWrist(x, t) {
    wristHistory.push({ x, t });
    if (wristHistory.length > cfg.swipeWindow) wristHistory.shift();
    if (swipeLocked && x > 0.35 && x < 0.65) swipeLocked = false;
  }
  function _detectSwipe(now) {
    if (swipeLocked || wristHistory.length < 4) return null;
    const oldest = wristHistory[0];
    const newest = wristHistory[wristHistory.length - 1];
    const dt = newest.t - oldest.t;
    const dx = newest.x - oldest.x;
    if (dt < cfg.swipeMinMs || dt > cfg.swipeMaxMs) return null;
    if (dx >  cfg.swipeThreshold) { wristHistory = []; return "swipe_left";  }
    if (dx < -cfg.swipeThreshold) { wristHistory = []; return "swipe_right"; }
    return null;
  }

  function _drawLandmarks(res) {
    if (!ctx || !canvasEl) return;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    const lm = res.landmarks?.[0];
    if (!lm) return;
    ctx.fillStyle = "rgba(176, 120, 73, 0.65)";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * canvasEl.width, p.y * canvasEl.height, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // test surface
  function __forTest({ onGesture: cb, confidence, confirmFrames, cooldownMs, idleMs } = {}) {
    onGesture = cb;
    if (confidence)   cfg.confidence    = { ...cfg.confidence, ...confidence };
    if (confirmFrames) cfg.confirmFrames = { ...cfg.confirmFrames, ...confirmFrames };
    if (cooldownMs   != null) cfg.cooldownMs = cooldownMs;
    if (idleMs       != null) cfg.idleMs     = idleMs;
    _reset(); lastFireAt = 0;
    return { _tick };
  }

  return { init, start, stop, getDiagnostics, __forTest };
})();
