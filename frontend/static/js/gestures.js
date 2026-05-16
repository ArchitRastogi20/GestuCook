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

  // Swipe (wrist-trajectory) layer.
  swipeWindow:    24,
  swipeThreshold: 0.16,
  swipeMinMs:     120,
  swipeMaxMs:     600,
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
    const thumbUp = ext.thumb && tipProj.thumb > knuckleProj && highestTip("thumb");
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
  let idleEmitted = false;

  // open-palm hold state
  let palmHoldStart = 0;
  let palmHoldFired = false;

  // swipe state
  let wristHistory = [];
  let swipeLocked = false;

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
        minTrackingConfidence:      0.5,
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
    _draw(res);

    const lm = res.landmarks && res.landmarks[0];
    const hasHand = !!(lm && lm.length >= 21);

    if (!hasHand) {
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

    const held = candLabel ? now - candSince : 0;
    const confirmed = !!candLabel && held >= cfg.confirmMs;
    _drawRing(candLabel ? Math.min(1, held / cfg.confirmMs) : 0, confirmed, needRelease);

    lastFrame = {
      hasHand: true, label: g, cand: candLabel,
      fill: candLabel ? Math.min(1, held / cfg.confirmMs) : 0,
      canned: canned.categoryName, needRelease, fps,
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

    // Swipe layer: only attempt when the hand holds no recognised static pose.
    if (g === "None") {
      _trackWrist(lm[LM.WRIST].x, now);
      const swipe = _detectSwipe(now);
      if (swipe) { _fire(swipe, now, "swipe", 0); return; }
    } else {
      wristHistory = [];
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
    if (wristHistory.length > cfg.swipeWindow) wristHistory.shift();
    // re-arm once the hand returns to the centre band after a swipe
    if (swipeLocked && x > 0.35 && x < 0.65) swipeLocked = false;
  }

  function _detectSwipe(now) {
    if (swipeLocked || wristHistory.length < 4) return null;
    const a = wristHistory[0];
    const b = wristHistory[wristHistory.length - 1];
    const dt = b.t - a.t;
    const dx = b.x - a.x;
    if (dt < cfg.swipeMinMs || dt > cfg.swipeMaxMs) return null;
    // Display is CSS-mirrored, so a hand moving to the user's right travels in
    // -x in the raw frame -> swipe_right.
    if (dx >  cfg.swipeThreshold) { wristHistory = []; return "swipe_left";  }
    if (dx < -cfg.swipeThreshold) { wristHistory = []; return "swipe_right"; }
    return null;
  }

  function _draw(res) {
    if (!ctx || !canvasEl) return;
    const W = canvasEl.width, H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);
    const lm = res.landmarks && res.landmarks[0];
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
