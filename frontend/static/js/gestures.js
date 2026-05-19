// frontend/static/js/gestures.js
// Deterministic hand-gesture pipeline for GestuCook.
//
// Why this is built the way it is:
//   MediaPipe's canned gesture classifier emits an UNCALIBRATED confidence
//   score that jitters frame-to-frame -- gating it at a fixed threshold (the
//   old design) made thumbs-up nearly impossible to trigger. Landmark
//   *tracking*, however, is rock solid. So:
//
//   1. The MediaPipe GestureRecognizer runs only to give us the 21 hand
//      landmarks (it also returns its own label, which we keep for diagnostics).
//   2. We classify the pose ourselves, GEOMETRICALLY, from finger curl/extend
//      angles. Same landmarks -> same label, every frame. Deterministic.
//   3. Confirmation is TIME based: a pose must be held steadily for confirmMs.
//      This is frame-rate independent -- it behaves identically at 8 fps (slow
//      CPU) or 60 fps -- and brief jitter shorter than graceMs is absorbed.
//   4. After firing, a static gesture will NOT fire again until the hand
//      relaxes to a neutral pose ("release"). Holding thumbs-up no longer
//      machine-guns through every step.
//   5. A wrist-trajectory layer handles swipes.
//
// onGesture(name): thumbs_up, fist, open_palm, pointing_up, victory,
//                  open_palm_hold, swipe_left, swipe_right, idle
// onFrame(info):   per-frame raw classification, for the trainer / debug HUD.

import { FilesetResolver, GestureRecognizer } from "/static/vendor/mediapipe/vision_bundle.mjs";

// ── MediaPipe hand-landmark indices ──────────────────────────────────
// 0 wrist · thumb 1-4 · index 5-8 · middle 9-12 · ring 13-16 · pinky 17-20
const LM = {
  WRIST:  0,
  THUMB:  { mcp: 2,  pip: 3,  tip: 4  },
  INDEX:  { mcp: 5,  pip: 6,  tip: 8  },
  MIDDLE: { mcp: 9,  pip: 10, tip: 12 },
  RING:   { mcp: 13, pip: 14, tip: 16 },
  PINKY:  { mcp: 17, pip: 18, tip: 20 },
};

const DEFAULTS = {
  capture:  { width: 640, height: 480 },  // 320x240 starved the model; 640 is the single biggest win
  warmupMs: 400,                          // ignore the first frames while the camera auto-exposes

  // Finger curl: cosine of the MCP->PIP / PIP->TIP direction continuity.
  // ~1 = straight finger, <0 = curled into the palm. Values between the two
  // thresholds are "ambiguous" and keep the previous state (hysteresis), so a
  // finger sitting on the boundary never flickers.
  fingerExtendCos: 0.55,
  fingerCurlCos:   0.10,
  thumbExtendCos:  0.30,   // the thumb bends more, so it gets a looser bar
  thumbCurlCos:   -0.20,

  // Confirmation: hold a pose steadily this long to fire it. Time based, so
  // it works the same regardless of how fast the (CPU-only) pipeline runs.
  confirmMs: 350,
  graceMs:   170,          // jitter / brief tracking loss shorter than this is ignored

  cooldownMs:     1100,    // dead time after any fire
  palmCooldownMs:  600,
  idleMs:         3000,    // no hand this long -> emit "idle"
  holdMs:         1200,    // open palm held this long -> "open_palm_hold"

  // Swipe (wrist-trajectory) layer. Operates on the SMOOTHED wrist x.
  swipeWindowMs:   650,    // trajectory history horizon
  swipeMinMs:       80,    // reject sub-flick noise
  swipeMinTravel:  0.12,   // net |dx| as a fraction of frame width
  swipeMonotonic:  0.62,   // fraction of per-sample steps moving the dominant way
  swipeSettleMs:   220,    // wrist still this long -> re-arm (anywhere, not just centre)
  swipeSettleSpan: 0.035,  // "still" = horizontal span below this
  swipeArmMs:      160,    // ignore swipes briefly after the hand (re)appears
  moveThreshold:   0.09,   // wrist travel above this = moving (cancels a static-pose hold)

  // One-Euro landmark smoothing. Adaptive low-pass: smooths a held pose hard
  // (kills the jitter that made thumbs-up flicker) and a fast swipe little
  // (no smear). Casiez et al., CHI 2012.
  oneEuro: { minCutoff: 1.4, beta: 0.45, dCutoff: 1.0 },
};

export const TO_ACTION = {
  Thumb_Up:    "thumbs_up",
  Closed_Fist: "fist",
  Open_Palm:   "open_palm",
  Pointing_Up: "pointing_up",
  Victory:     "victory",
};

// ── geometry helpers ─────────────────────────────────────────────────
function sub(a, b)  { return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) }; }
function dot(a, b)  { return a.x * b.x + a.y * b.y + a.z * b.z; }
function mag(a)     { return Math.hypot(a.x, a.y, a.z) || 1e-6; }

// Direction continuity along a finger: cosine of the angle between the
// MCP->PIP segment and the PIP->TIP segment. ~1 = straight, <0 = curled.
function chainCos(p0, p1, p2) {
  const d1 = sub(p1, p0), d2 = sub(p2, p1);
  return dot(d1, d2) / (mag(d1) * mag(d2));
}

// ── One-Euro filter ──────────────────────────────────────────────────
// Adaptive low-pass filter (Casiez et al., CHI 2012). The cutoff frequency
// rises with the signal's speed, so slow motion (a held pose) is smoothed
// hard while fast motion (a swipe) passes through almost untouched -- exactly
// the trade-off a noisy CPU-only landmark stream needs.
class OneEuroFilter {
  constructor({ minCutoff = 1.4, beta = 0.45, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;   // last filtered value
    this.dx = 0;     // last filtered derivative
    this.t = null;   // last timestamp, seconds
  }
  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(value, tMs) {
    const t = tMs / 1000;
    if (this.x === null) { this.x = value; this.t = t; return value; }
    let dt = t - this.t;
    if (!(dt > 0)) dt = 1 / 30;          // guard a zero / non-monotonic timestamp
    this.t = t;
    const dValue = (value - this.x) / dt;
    const aD = this._alpha(this.dCutoff, dt);
    this.dx = aD * dValue + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = this._alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

// One filter per coordinate of every landmark (21 x 3). Smooths a whole frame
// of landmarks in place of the raw, jittery ones.
class HandSmoother {
  constructor(opts) {
    this.opts = opts;
    this.fx = []; this.fy = []; this.fz = [];
    for (let i = 0; i < 21; i++) {
      this.fx.push(new OneEuroFilter(opts));
      this.fy.push(new OneEuroFilter(opts));
      this.fz.push(new OneEuroFilter(opts));
    }
  }
  reset() {
    for (let i = 0; i < 21; i++) { this.fx[i].reset(); this.fy[i].reset(); this.fz[i].reset(); }
  }
  smooth(lm, tMs) {
    const out = new Array(lm.length);
    for (let i = 0; i < lm.length; i++) {
      out[i] = {
        x: this.fx[i].filter(lm[i].x, tMs),
        y: this.fy[i].filter(lm[i].y, tMs),
        z: this.fz[i].filter(lm[i].z || 0, tMs),
      };
    }
    return out;
  }
}

// Per-finger extend/curl state, persisted across frames for hysteresis.
let fingerState = { thumb: false, index: false, middle: false, ring: false, pinky: false };
function _resetFingers() {
  fingerState = { thumb: false, index: false, middle: false, ring: false, pinky: false };
}

// Geometric, deterministic pose classifier.
// Returns { label, extended } where label is one of:
//   Thumb_Up, Closed_Fist, Open_Palm, Victory, Pointing_Up, None
function classifyHand(lm, cfg) {
  const wrist = lm[LM.WRIST];

  // Hand "up" axis: wrist -> middle knuckle. Using this instead of raw screen-Y
  // lets the up-tests tolerate a tilted hand.
  const uRaw = sub(lm[LM.MIDDLE.mcp], wrist);
  const uLen = mag(uRaw);
  const up = { x: uRaw.x / uLen, y: uRaw.y / uLen, z: uRaw.z / uLen };
  const proj = (p) => dot(sub(p, wrist), up);   // height along the up axis

  function extended(f, isThumb) {
    const c  = chainCos(lm[f.mcp], lm[f.pip], lm[f.tip]);
    const hi = isThumb ? cfg.thumbExtendCos : cfg.fingerExtendCos;
    const lo = isThumb ? cfg.thumbCurlCos   : cfg.fingerCurlCos;
    if (c >= hi) return true;
    if (c <= lo) return false;
    return null;   // ambiguous -> keep previous state
  }

  const next = {
    thumb:  extended(LM.THUMB,  true),
    index:  extended(LM.INDEX,  false),
    middle: extended(LM.MIDDLE, false),
    ring:   extended(LM.RING,   false),
    pinky:  extended(LM.PINKY,  false),
  };
  for (const k of Object.keys(next)) {
    if (next[k] === null) next[k] = fingerState[k];   // hysteresis
  }
  fingerState = next;
  const ext = next;

  const nExt = [ext.index, ext.middle, ext.ring, ext.pinky].filter(Boolean).length;

  const tipProj = {
    thumb:  proj(lm[LM.THUMB.tip]),
    index:  proj(lm[LM.INDEX.tip]),
    middle: proj(lm[LM.MIDDLE.tip]),
    ring:   proj(lm[LM.RING.tip]),
    pinky:  proj(lm[LM.PINKY.tip]),
  };
  const knuckleProj  = proj(lm[LM.MIDDLE.mcp]);             // == hand scale, by construction
  const highestTip   = (key) => Object.keys(tipProj).every(k => k === key || tipProj[key] > tipProj[k]);

  let label = "None";
  if (nExt === 0) {
    // Closed hand -- the thumb decides between a fist and a thumbs-up.
    //
    // The old test projected the thumb tip onto the wrist->middle-MCP up axis.
    // That axis ROTATES with the hand, so for a real thumbs-up (hand turned
    // ~90 deg) it points sideways and the test fails -- the core reason
    // thumbs-up "often isn't recognised". This version is rotation invariant:
    //   1. the thumb juts well clear of the curled fist, and
    //   2. its tip sits above the palm in SCREEN space (y grows downward).
    const mcps = [lm[LM.INDEX.mcp], lm[LM.MIDDLE.mcp], lm[LM.RING.mcp], lm[LM.PINKY.mcp]];
    const palm = {
      x: (mcps[0].x + mcps[1].x + mcps[2].x + mcps[3].x) / 4,
      y: (mcps[0].y + mcps[1].y + mcps[2].y + mcps[3].y) / 4,
    };
    const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const handScale2d = Math.hypot(lm[LM.MIDDLE.mcp].x - wrist.x,
                                   lm[LM.MIDDLE.mcp].y - wrist.y) || 1e-6;
    const curlReach = (dist2(lm[LM.INDEX.tip], palm) + dist2(lm[LM.MIDDLE.tip], palm) +
                       dist2(lm[LM.RING.tip], palm) + dist2(lm[LM.PINKY.tip], palm)) / 4;
    const thumbReach = dist2(lm[LM.THUMB.tip], palm);
    const thumbOut = ext.thumb && thumbReach > 1.25 * curlReach;
    const thumbUp  = thumbOut && lm[LM.THUMB.tip].y < palm.y - 0.05 * handScale2d;
    label = thumbUp ? "Thumb_Up" : "Closed_Fist";
  } else if (nExt === 4) {
    label = "Open_Palm";
  } else if (ext.index && ext.middle && !ext.ring && !ext.pinky) {
    label = "Victory";
  } else if (ext.index && !ext.middle && !ext.ring && !ext.pinky &&
             tipProj.index > knuckleProj && highestTip("index")) {
    label = "Pointing_Up";
  }

  return { label, extended: ext };
}

// ── hand skeleton, for the landmark overlay ──────────────────────────
const BONES = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];

export const GestureEngine = (() => {
  let recognizer = null;
  let onGesture  = null;
  let onFrame    = null;
  let videoEl = null, canvasEl = null, ctx = null;
  let running   = false;
  let startedAt = 0;
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));

  // One-Euro smoother for the 21 landmarks; rebuilt if cfg.oneEuro changes.
  let handSmoother = new HandSmoother(cfg.oneEuro);

  // confirmation state -- a pose must be HELD steadily for confirmMs.
  let candLabel  = null;   // pose currently being held toward a fire
  let candSince  = 0;      // when the candidate pose started
  let altLabel   = null;   // a competing pose glimpsed during the hold
  let altSince   = 0;
  let lastPoseAt = 0;      // last frame that showed any real (non-None) pose

  // fire bookkeeping -- survives screen transitions (NOT cleared by _reset)
  let lastFireAt    = 0;
  let lastFireClass = null;
  let needRelease   = false;   // must relax to a neutral hand before firing again

  let lastSeenHandAt = 0;
  let handArrivedAt = 0;
  let idleEmitted = false;

  // open-palm hold state
  let palmHoldStart = 0;
  let palmHoldFired = false;

  // swipe state
  let wristHistory = [];
  let swipeLocked = false;
  let lastSwipeDx = 0;     // diagnostics: net wrist travel at the last evaluation
  let lastSwipeMono = 0;   // diagnostics: monotonicity fraction at the last evaluation

  // diagnostics
  const ring = [];                 // recent fires, read by ui/diag.js
  let fps = 0;
  let lastLoopAt = 0;
  let lastFrame = { hasHand: false, label: "None", cand: null, fill: 0, fps: 0 };
  function getDiagnostics() { return ring.slice(); }
  function getLastFrame()   { return { ...lastFrame, fps: Math.round(fps) }; }

  async function init(video, canvas, gestureCb) {
    videoEl = video;
    canvasEl = canvas;
    ctx = canvas ? canvas.getContext("2d") : null;
    onGesture = gestureCb || null;
    onFrame = null;   // each screen re-registers a frame observer if it wants one

    if (!recognizer) {
      const vision = await FilesetResolver.forVisionTasks("/static/vendor/mediapipe/wasm");
      recognizer = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "/static/vendor/mediapipe/gesture_recognizer.task",
          delegate: "CPU",          // this machine has no GPU
        },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence:  0.5,
        // Lowered from 0.5: keeps the hand locked through the motion blur of a
        // fast swipe instead of dropping tracking halfway through the gesture.
        minTrackingConfidence:      0.3,
      });
    }
  }

  // Per-frame raw classification stream (used by the gesture trainer / debug HUD).
  function setFrameObserver(cb) { onFrame = cb || null; }

  async function start() {
    if (running || !recognizer) return;
    running = true;
    _reset();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:      { ideal: cfg.capture.width },
        height:     { ideal: cfg.capture.height },
        facingMode: "user",
      },
      audio: false,
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    startedAt = performance.now();
    lastLoopAt = startedAt;
    _loop();
  }

  function stop() {
    running = false;
    if (videoEl?.srcObject) {
      videoEl.srcObject.getTracks().forEach(t => t.stop());
      videoEl.srcObject = null;
    }
    _reset();
  }

  // Clear pose/vote/swipe state. Does NOT touch fire history (lastFireAt,
  // lastFireClass, needRelease) -- those must survive a screen transition so a
  // still-held gesture can't immediately re-fire on the next screen.
  function _clearPose() {
    candLabel = null;
    altLabel = null;
    wristHistory = [];
    swipeLocked = false;
    palmHoldStart = 0;
    palmHoldFired = false;
    _resetFingers();
  }

  function _reset() {
    _clearPose();
    handSmoother.reset();
    idleEmitted = false;
  }

  async function _loop() {
    if (!running) return;
    const now = performance.now();
    const dt = now - lastLoopAt;
    lastLoopAt = now;
    if (dt > 0) fps = fps ? fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;

    if (videoEl.readyState >= 2 && now - startedAt >= cfg.warmupMs) {
      let res = null;
      try { res = await recognizer.recognizeForVideo(videoEl, now); }
      catch { /* transient decode error -- skip this frame */ }
      if (res) _tick(res, now);
    }
    requestAnimationFrame(_loop);
  }

  function _tick(res, now) {
    const rawLm = res.landmarks && res.landmarks[0];
    const hasHand = !!(rawLm && rawLm.length >= 21);

    if (!hasHand) {
      _draw(null);
      handSmoother.reset();         // a re-appearing hand starts clean, no lurch
      if (!idleEmitted && lastSeenHandAt > 0 && now - lastSeenHandAt > cfg.idleMs) {
        idleEmitted = true;
        onGesture && onGesture("idle");
      }
      needRelease = false;          // hand gone == release; re-arm static gestures
      _clearPose();                 // keep idleEmitted so "idle" fires once, not every frame
      lastFrame = { hasHand: false, label: "None", cand: null, fill: 0, fps };
      onFrame && onFrame({ hasHand: false, label: "None", voteLabel: "None", voteFill: 0 });
      return;
    }

    // Smooth the 21 landmarks before ANY classification or wrist tracking --
    // every downstream test then works on a de-noised signal.
    const lm = handSmoother.smooth(rawLm, now);
    _draw(lm);

    if (now - lastSeenHandAt > 400) handArrivedAt = now;   // hand just (re)appeared
    lastSeenHandAt = now;
    idleEmitted = false;

    const geo    = classifyHand(lm, cfg);
    const canned = (res.gestures && res.gestures[0] && res.gestures[0][0]) ||
                   { categoryName: "None", score: 0 };
    const g = geo.label;

    // ── candidate-hold tracking (frame-rate independent) ──────────────
    if (g === "None") {
      needRelease = false;          // a neutral hand re-arms static gestures
      // brief None tolerated; only drop the candidate after graceMs of nothing
      if (candLabel && now - lastPoseAt >= cfg.graceMs) { candLabel = null; altLabel = null; }
    } else {
      lastPoseAt = now;
      if (g === candLabel) {
        altLabel = null;            // candidate reaffirmed
      } else if (g === altLabel) {
        if (now - altSince >= cfg.graceMs) {   // competitor held long enough -> switch
          candLabel = g; candSince = altSince; altLabel = null;
        }
      } else if (!candLabel) {
        candLabel = g; candSince = now; altLabel = null;
      } else {
        altLabel = g; altSince = now;          // brief blip -> just note it
      }
    }

    // Wrist trajectory: tracked every frame. A moving hand is a swipe; a still
    // hand is a held pose. They never collide -- a pose must be held still.
    _trackWrist(lm[LM.WRIST].x, now);
    if (_wristSpan() > cfg.moveThreshold) candSince = now;   // moving -> not "held"

    const held = candLabel ? now - candSince : 0;
    const confirmed = !!candLabel && held >= cfg.confirmMs;
    _drawRing(candLabel ? Math.min(1, held / cfg.confirmMs) : 0, confirmed, needRelease);

    lastFrame = {
      hasHand: true, label: g, cand: candLabel,
      fill: candLabel ? Math.min(1, held / cfg.confirmMs) : 0,
      canned: canned.categoryName, needRelease, fps,
      swipeDx: lastSwipeDx, swipeMono: lastSwipeMono,
    };
    onFrame && onFrame({
      hasHand:     true,
      label:       g,
      extended:    geo.extended,
      cannedLabel: canned.categoryName,
      cannedScore: canned.score,
      voteLabel:   candLabel || "None",
      voteFill:    lastFrame.fill,
    });

    // Track open-palm hold timing even during cooldown, so the hold can mature.
    if (g === "Open_Palm") {
      if (palmHoldStart === 0) palmHoldStart = now;
    } else {
      palmHoldStart = 0;
      palmHoldFired = false;
    }

    const cooldown = lastFireClass === "Open_Palm" ? cfg.palmCooldownMs : cfg.cooldownMs;
    if (now - lastFireAt < cooldown) return;

    // Swipe: a deliberate horizontal sweep, recognised in any hand pose.
    if (now - handArrivedAt > cfg.swipeArmMs) {
      const swipe = _detectSwipe();
      if (swipe) { _fire(swipe, now, "swipe", 0); return; }
    }

    // Open palm held long enough -> sticky step-lock toggle.
    if (g === "Open_Palm" && !palmHoldFired && palmHoldStart > 0 &&
        now - palmHoldStart >= cfg.holdMs) {
      palmHoldFired = true;
      _fire("open_palm_hold", now, "hold", canned.score);
      return;
    }

    // Static pose: fire once it's been held confirmMs -- but only if the hand
    // has been released since the last fire (no machine-gunning).
    if (confirmed && !needRelease && TO_ACTION[candLabel]) {
      _fire(TO_ACTION[candLabel], now, "static", canned.score);
    }
  }

  function _fire(actionName, now, source, score) {
    lastFireAt = now;
    lastFireClass = Object.keys(TO_ACTION).find(k => TO_ACTION[k] === actionName) || lastFireClass;
    if (source === "static" || source === "hold") needRelease = true;
    candLabel = null;
    altLabel = null;
    wristHistory = [];
    swipeLocked = true;
    ring.push({ ts: Date.now(), class: actionName, score: score || 0, source });
    if (ring.length > 50) ring.shift();
    onGesture && onGesture(actionName);
  }

  function _trackWrist(x, t) {
    wristHistory.push({ x, t });
    // Keep only a recent TIME window, so detection is framerate independent.
    const cutoff = t - cfg.swipeWindowMs;
    while (wristHistory.length && wristHistory[0].t < cutoff) wristHistory.shift();

    // Re-arm: the old code only unlocked when the wrist returned to the centre
    // 0.35-0.65 band, so a user who swiped and left their hand at the side
    // could never swipe again. Now it re-arms wherever the hand SETTLES --
    // little horizontal travel over the last swipeSettleMs.
    if (swipeLocked) {
      const since = t - cfg.swipeSettleMs;
      let lo = Infinity, hi = -Infinity, n = 0;
      for (const p of wristHistory) {
        if (p.t < since) continue;
        n++;
        if (p.x < lo) lo = p.x;
        if (p.x > hi) hi = p.x;
      }
      if (n >= 2 && hi - lo < cfg.swipeSettleSpan) swipeLocked = false;
    }
  }

  // Total horizontal travel of the wrist across the tracked window.
  function _wristSpan() {
    if (wristHistory.length < 2) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const p of wristHistory) { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x; }
    return hi - lo;
  }

  // A swipe is a deliberate sweep: enough NET travel in one direction, and a
  // path that mostly moves that one way (so a back-and-forth wave is rejected).
  function _detectSwipe() {
    if (swipeLocked || wristHistory.length < 4) return null;
    const first = wristHistory[0];
    const last  = wristHistory[wristHistory.length - 1];
    if (last.t - first.t < cfg.swipeMinMs) return null;

    const dx = last.x - first.x;
    lastSwipeDx = dx;
    const dir = Math.sign(dx);
    if (dir === 0) return null;

    // Monotonicity: fraction of per-sample steps moving the dominant direction.
    let agree = 0, total = 0;
    for (let i = 1; i < wristHistory.length; i++) {
      const step = wristHistory[i].x - wristHistory[i - 1].x;
      if (step === 0) continue;
      total++;
      if (Math.sign(step) === dir) agree++;
    }
    lastSwipeMono = total > 0 ? agree / total : 0;

    if (Math.abs(dx) < cfg.swipeMinTravel) return null;
    if (lastSwipeMono < cfg.swipeMonotonic) return null;

    wristHistory = [];
    // Display is CSS-mirrored: a hand moving to the user's right travels -x raw.
    return dx > 0 ? "swipe_left" : "swipe_right";
  }

  // Draws the (already smoothed) landmark skeleton. Pass null to just clear.
  function _draw(lm) {
    if (!ctx || !canvasEl) return;
    const W = canvasEl.width, H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);
    if (!lm) return;

    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(176, 120, 73, 0.55)";
    for (const [a, b] of BONES) {
      ctx.beginPath();
      ctx.moveTo(lm[a].x * W, lm[a].y * H);
      ctx.lineTo(lm[b].x * W, lm[b].y * H);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(176, 120, 73, 0.85)";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, 3, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  // Hold-to-commit progress ring, top-right of the webcam tile. Fills as a pose
  // is held; turns sage when it fires; turns pale while waiting for a release.
  function _drawRing(fill, confirmed, blocked) {
    if (!ctx || !canvasEl) return;
    const r = 15, cx = canvasEl.width - r - 8, cy = r + 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.30)";
    ctx.stroke();
    if (fill <= 0) return;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + fill * 2 * Math.PI);
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.strokeStyle = blocked   ? "rgba(238, 230, 220, 0.55)"   // waiting for release
                    : confirmed ? "rgba(120, 170, 110, 0.95)"   // fired
                    :             "rgba(176, 120, 73, 0.95)";   // filling
    ctx.stroke();
  }

  // test surface -- feed synthetic landmark frames to _tick
  function __forTest(opts = {}) {
    onGesture = opts.onGesture || null;
    onFrame   = opts.onFrame   || null;
    if (opts.cfg) cfg = { ...cfg, ...opts.cfg };
    handSmoother = new HandSmoother(cfg.oneEuro);
    _reset();
    // Synthetic frames start their clock at 0; production uses performance.now()
    // (a large value). Pre-date lastFireAt so the startup cooldown is elapsed.
    lastFireAt = -1e7;
    lastFireClass = null;
    lastSeenHandAt = 0;
    needRelease = false;
    return {
      _tick,
      classifyHand: (lm) => classifyHand(lm, cfg),
    };
  }

  return { init, start, stop, setFrameObserver, getDiagnostics, getLastFrame, __forTest };
})();
