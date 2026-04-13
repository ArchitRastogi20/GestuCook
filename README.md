# GestuCook

A gesture-controlled, voice-enabled recipe assistant. Users photograph their ingredients or speak them aloud, receive AI-generated recipes, and navigate the entire cooking experience hands-free using webcam-based hand gestures and voice commands.

The core research question: **how do you design a multimodal interface for recipe navigation when the user's hands are occupied?**

---

## What the project does

1. User enters their name and picks a mode: **photo** or **hands-free**.
2. In photo mode, they upload images of food items. The LLM (GPT-5.4 Nano or Gemma 4 31B via OpenRouter) identifies ingredients from the images.
3. In hands-free mode, they press a mic button and speak their ingredients. The ASR service (faster-whisper) transcribes the audio.
4. Both paths converge: the LLM generates 2-3 structured recipes as JSON.
5. Recipes appear in a **carousel**. The user navigates with hand gestures detected by MediaPipe Hands running in the browser via webcam.
6. After selecting a recipe (thumbs up gesture), the app enters **cooking mode**: a step-by-step walkthrough where each step can be read aloud by the TTS service (Piper), and navigation is entirely gesture- and voice-driven.
7. A live cost counter tracks API token usage and estimated USD cost throughout the session.

---

## Architecture

Four Docker containers orchestrated by Docker Compose, plus a browser-side gesture engine:

```
Browser (client)
  HTML/CSS/JS + MediaPipe Hands (webcam) + Web Audio (mic)
       |
       | HTTP
       v
+----------------------------------------------------+
|  Docker Compose                                     |
|                                                     |
|  Nginx (:3080) --/api/--> FastAPI backend (:3081)   |
|                              |          |           |
|                    ASR service (:3082)   |           |
|                    (faster-whisper)      |           |
|                                         |           |
|                    TTS service (:3083)   |           |
|                    (Piper)              |           |
+----------------------------------------------------+
                                          |
                                          | HTTPS
                                          v
                                   OpenAI API
                                   or OpenRouter
                                   (env var switch)
```

**Frontend** (Nginx): serves static HTML/CSS/JS. Proxies `/api/*` requests to the backend. MediaPipe Hands runs entirely in the browser via CDN — no GPU or extra service needed.

**Backend** (FastAPI): orchestrates all logic. Receives image uploads, forwards to LLM for ingredient detection, generates recipes, proxies ASR/TTS requests. Tracks token usage with tiktoken (o200k_base encoding) and computes image token costs using the patch-based formula (32x32 patches, 1536 budget, 2.46x multiplier for gpt-5.4-nano).

**ASR service** (faster-whisper): receives audio blobs from the browser, transcribes to text using the Whisper tiny model on CPU.

**TTS service** (Piper): receives text, returns WAV audio using the en_US-lessac-medium voice model.

**LLM provider**: configurable via environment variable. Set `LLM_PROVIDER=openai` for GPT-5.4 Nano ($0.20/M input, $1.25/M output) or `LLM_PROVIDER=openrouter` for Gemma 4 31B free tier ($0). Both support vision (image input).

---

## Gesture vocabulary

All gesture recognition happens client-side via MediaPipe Hands. The engine uses a state-machine approach: a pose must be held for 5 consecutive frames before it fires, followed by a 1.8-second cooldown to prevent repeated triggers.

### Recipe carousel screen

| Gesture | Action |
|---|---|
| Swipe hand right | Next recipe |
| Swipe hand left | Previous recipe |
| Thumbs up (hold) | Select recipe, enter cooking mode |
| Closed fist (hold) | Go back to mode selection |

### Cooking mode (step-by-step)

| Gesture | Action |
|---|---|
| Swipe hand right | Next step |
| Swipe hand left | Previous step |
| Open palm (hold) | Read current step aloud via TTS |
| Thumbs up (hold) | Next step |
| Closed fist (hold) | Exit cooking, return to carousel |

### How detection works

**Static poses** (thumbs up, fist, open palm): the engine checks finger tip positions relative to PIP and MCP joints each frame. A pose must appear in 5 consecutive frames to confirm. After firing, a 1.8s global cooldown blocks all gestures.

**Swipes**: wrist position is tracked over a 20-frame sliding window. A swipe fires when the wrist moves more than 0.18 normalized distance within 120-600ms. After a swipe, the hand must return to the center zone (0.35-0.65 of frame width) before another swipe is allowed.

**TTS overlap prevention**: only one audio clip plays at a time. If a new "read aloud" gesture fires while audio is playing, the previous audio is stopped first. A fetch-in-flight flag prevents duplicate API calls.

---

## User workflow

```
Enter name
    |
    +---> Photo mode: upload images --> LLM detects ingredients
    |
    +---> Hands-free mode: speak into mic --> ASR transcribes
    |
    v
LLM generates 2-3 recipes (JSON)
    |
    v
Recipe carousel (gesture-navigated)
    |  thumbs up
    v
Cooking mode: step-by-step
    - swipe to navigate steps
    - open palm to hear step read aloud
    - fist to exit back to carousel
```

---

## How to run

1. Clone
2. Make `.env` and add your API keys:
   ```
   LLM_PROVIDER=openrouter
   OPENROUTER_API_KEY=sk-or-v1-your-key-here
   ```
3. Run:
   ```
   docker compose up --build
   ```
4. Open http://localhost:3080
5. Allow camera and microphone access when prompted

### Ports

| Service | Port |
|---|---|
| Frontend (Nginx) | 3080 |
| Backend (FastAPI) | 3081 |
| ASR (faster-whisper) | 3082 |
| TTS (Piper) | 3083 |

### First build

The first `docker compose up --build` downloads model files (~175MB total: Whisper tiny + Piper voice). Subsequent builds use Docker cache.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, vanilla JS, MediaPipe Hands |
| Backend | Python, FastAPI, httpx, tiktoken, Pillow |
| ASR | faster-whisper (Whisper tiny, CPU, int8) |
| TTS | Piper TTS (en_US-lessac-medium ONNX) |
| LLM | GPT-5.4 Nano (OpenAI) or Gemma 4 31B (OpenRouter free) |
| Infrastructure | Docker Compose, Nginx reverse proxy |

---

## Project structure

```
gestucook/
  .env.example          # environment template
  docker-compose.yml    # all 4 services
  nginx.conf            # reverse proxy config
  frontend/
    index.html          # single-page app
    static/
      css/style.css     # dark theme, Material-inspired
      js/gestures.js    # MediaPipe gesture state machine
      js/app.js         # application logic, TTS queue
  backend/
    Dockerfile
    main.py             # FastAPI routes, LLM calls, cost tracking
    requirements.txt
  asr_service/
    Dockerfile
    main.py             # faster-whisper transcription
    requirements.txt
  tts_service/
    Dockerfile
    main.py             # Piper speech synthesis
    requirements.txt
```

---
