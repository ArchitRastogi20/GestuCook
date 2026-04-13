// gestures.js - Robust MediaPipe Hands gesture recognition
// State-machine approach: detect pose, require it to be HELD for N frames,
// then fire ONCE, then enter cooldown. No repeated triggers.

const GestureEngine = (() => {
    let hands = null;
    let camera = null;
    let videoEl = null;
    let canvasEl = null;
    let canvasCtx = null;
    let onGesture = null;
    let running = false;

    // ── state machine ────────────────────────────────────
    // A gesture must be seen for CONFIRM_FRAMES consecutive frames
    // before it fires. After firing, COOLDOWN_MS must pass before
    // any gesture (same or different) can fire again.

    const CONFIRM_FRAMES = 5;
    const COOLDOWN_MS = 1800;

    let candidateGesture = null;   // what we think user is doing
    let candidateCount = 0;        // how many frames we've seen it
    let lastFiredTime = 0;         // when we last emitted a gesture
    let inCooldown = false;

    // ── swipe tracking (separate from static poses) ──────
    // We track wrist position over a sliding window.
    // A swipe is: wrist moved > SWIPE_THRESHOLD in < SWIPE_MAX_MS
    // After a swipe fires, we require hand to return near center
    // before another swipe can happen.

    const SWIPE_THRESHOLD = 0.18;
    const SWIPE_MAX_MS = 600;
    const SWIPE_MIN_MS = 120;

    let wristHistory = [];         // [{x, t}, ...]
    const WRIST_HISTORY_MAX = 20;
    let swipeLocked = false;       // prevent rapid re-swipe

    function init(video, canvas, callback) {
        videoEl = video;
        canvasEl = canvas;
        canvasCtx = canvas.getContext("2d");
        onGesture = callback;

        hands = new window.Hands({
            locateFile: (file) =>
                "https://cdn.jsdelivr.net/npm/@mediapipe/hands/" + file,
        });

        hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 0,
            minDetectionConfidence: 0.65,
            minTrackingConfidence: 0.55,
        });

        hands.onResults(processResults);
    }

    async function start() {
        if (running) return;
        running = true;
        resetState();

        camera = new window.Camera(videoEl, {
            onFrame: async () => {
                if (!running) return;
                await hands.send({ image: videoEl });
            },
            width: 320,
            height: 240,
        });
        await camera.start();
    }

    function stop() {
        running = false;
        if (camera) {
            camera.stop();
            camera = null;
        }
        resetState();
    }

    function resetState() {
        candidateGesture = null;
        candidateCount = 0;
        inCooldown = false;
        wristHistory = [];
        swipeLocked = false;
    }

    // ── main processing loop ─────────────────────────────
    function processResults(results) {
        canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

        if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
            // no hand visible: reset candidate but keep cooldown
            candidateGesture = null;
            candidateCount = 0;
            wristHistory = [];
            swipeLocked = false;
            return;
        }

        const lm = results.multiHandLandmarks[0];
        drawLandmarks(lm);

        const now = Date.now();

        // check cooldown
        if (inCooldown) {
            if (now - lastFiredTime >= COOLDOWN_MS) {
                inCooldown = false;
            } else {
                // still in cooldown: track wrist but don't recognize
                trackWrist(lm[0].x, now);
                return;
            }
        }

        // try swipe first (motion-based, separate from static poses)
        trackWrist(lm[0].x, now);
        const swipe = detectSwipe(now);
        if (swipe) {
            fireGesture(swipe, now);
            return;
        }

        // static pose recognition
        const pose = recognizeStaticPose(lm);

        if (pose === null) {
            // no recognizable pose
            candidateGesture = null;
            candidateCount = 0;
            return;
        }

        // same pose as before? increment counter
        if (pose === candidateGesture) {
            candidateCount++;
        } else {
            // different pose: restart counter
            candidateGesture = pose;
            candidateCount = 1;
        }

        // confirmed?
        if (candidateCount >= CONFIRM_FRAMES) {
            fireGesture(pose, now);
            candidateGesture = null;
            candidateCount = 0;
        }
    }

    function fireGesture(gesture, now) {
        lastFiredTime = now;
        inCooldown = true;
        // reset swipe state after any fire
        wristHistory = [];
        swipeLocked = true;

        if (onGesture) onGesture(gesture);
    }

    // ── drawing ──────────────────────────────────────────
    function drawLandmarks(lm) {
        canvasCtx.fillStyle = "rgba(245, 158, 11, 0.5)";
        for (var i = 0; i < lm.length; i++) {
            var p = lm[i];
            canvasCtx.beginPath();
            canvasCtx.arc(
                p.x * canvasEl.width,
                p.y * canvasEl.height,
                3, 0, 2 * Math.PI
            );
            canvasCtx.fill();
        }
    }

    // ── static pose recognition ──────────────────────────
    function recognizeStaticPose(lm) {
        // Landmarks:
        // 0=wrist 4=thumb_tip 3=thumb_ip 2=thumb_mcp
        // 8=index_tip 6=index_pip 5=index_mcp
        // 12=middle_tip 10=middle_pip
        // 16=ring_tip 14=ring_pip
        // 20=pinky_tip 18=pinky_pip

        var thumbTip = lm[4];
        var thumbIp = lm[3];
        var thumbMcp = lm[2];
        var wrist = lm[0];

        var tips = [lm[8], lm[12], lm[16], lm[20]];
        var pips = [lm[6], lm[10], lm[14], lm[18]];
        var mcps = [lm[5], lm[9], lm[13], lm[17]];

        // finger "up" = tip is significantly above pip (lower y)
        var margin = 0.03;
        var fingersUp = [];
        for (var i = 0; i < 4; i++) {
            fingersUp.push(tips[i].y < pips[i].y - margin);
        }

        // finger "curled" = tip is below mcp
        var fingersCurled = [];
        for (var i = 0; i < 4; i++) {
            fingersCurled.push(tips[i].y > mcps[i].y);
        }

        var allCurled = fingersCurled[0] && fingersCurled[1] &&
                        fingersCurled[2] && fingersCurled[3];
        var allUp = fingersUp[0] && fingersUp[1] &&
                    fingersUp[2] && fingersUp[3];

        var thumbUp = thumbTip.y < thumbIp.y - 0.04 &&
                      thumbTip.y < thumbMcp.y - 0.06;
        var thumbCurled = thumbTip.y > thumbIp.y;

        // THUMBS UP: thumb clearly above wrist, all 4 fingers curled
        if (thumbUp && allCurled && thumbTip.y < wrist.y - 0.12) {
            return "thumbs_up";
        }

        // CLOSED FIST: all fingers curled, thumb also curled or tucked
        if (allCurled && thumbCurled) {
            return "fist";
        }

        // OPEN PALM: all 4 fingers up and thumb extended
        // But we do NOT fire open_palm if wrist is moving fast (that's a swipe)
        if (allUp && thumbUp) {
            return "open_palm";
        }

        return null;
    }

    // ── swipe detection ──────────────────────────────────
    function trackWrist(x, t) {
        wristHistory.push({ x: x, t: t });
        // keep only recent entries
        while (wristHistory.length > WRIST_HISTORY_MAX) {
            wristHistory.shift();
        }

        // unlock swipe if wrist returned to center zone
        if (swipeLocked) {
            if (x > 0.35 && x < 0.65) {
                swipeLocked = false;
            }
        }
    }

    function detectSwipe(now) {
        if (swipeLocked) return null;
        if (wristHistory.length < 4) return null;

        // look at oldest vs newest in the window
        var oldest = wristHistory[0];
        var newest = wristHistory[wristHistory.length - 1];
        var dt = newest.t - oldest.t;
        var dx = newest.x - oldest.x;

        if (dt < SWIPE_MIN_MS || dt > SWIPE_MAX_MS) return null;

        // camera is mirrored: positive dx in data = user swiped left visually
        if (dx > SWIPE_THRESHOLD) {
            wristHistory = [];
            return "swipe_left";
        }
        if (dx < -SWIPE_THRESHOLD) {
            wristHistory = [];
            return "swipe_right";
        }

        return null;
    }

    return { init, start, stop };
})();
