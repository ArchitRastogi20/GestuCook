# GestuCook

A non-WIMP cooking interface. Voice, gesture, and audio carry the entire cooking flow: no clicks, no scrolls, hands stay on the food.

## What it does

You arrive at the welcome screen, type your name once. From then on, the app is gesture-first and voice-second:

1. **Pick a mode.** Photo (upload images of ingredients) or hands-free (speak them).
2. **The LLM identifies ingredients and proposes 2–3 recipes.** Gemma 4 31B (OpenRouter, free) or GPT-5.4 Nano (OpenAI) depending on your `.env`.
3. **Browse recipes by swiping your hand.** Featured card sits in a tactile bezel; previous and next recipes peek behind it. Thumbs up to start cooking, fist to go back.
4. **Cook step by step.** Steps with embedded durations get an automatic countdown timer. Open palm to read the current step aloud. Swipe to advance.
5. **Speak to navigate.** Say "next", "back", "repeat", or "pause". Say "save this" to keep a webcam frame of the dish. Say "kitchen mode" to enter the large-distance reading view. Ask "hey gestu, can I use spaghetti instead?" to get a bounded answer back as audio.
6. **At the end**, you hear a spoken epilogue: what you cooked, how long it took, how much the LLM cost in cents, and how many recipes you've cooked this month.

## The non-WIMP thesis

The point of GestuCook is to study how a multimodal interface works when the user's hands are busy. Every feature has to lean on voice, gesture, or audio, not on adding buttons.

## Architecture

Four Docker services, plus the browser doing the gesture and voice work.

```
Browser
  + Editorial Luxury UI (Fraunces, Geist, Geist Mono)
  + Voice command loop (always-on small ASR during cooking)
  + MediaPipe Tasks Vision: GestureRecognizer + custom swipe layer
  + IndexedDB for voice-tagged moments
  + localStorage for the user's name
       |
       | HTTP
       v
+-----------------------------------------------------+
|  docker compose                                     |
|                                                     |
|  Nginx (3080) --/api/--> FastAPI backend (3081)     |
|                                |       |            |
|                                |       +-- ASR :3082 (faster-whisper)
|                                |       +-- TTS :3083 (Piper)
|                                v                    |
|                       backend/db.py                 |
|                       motor 3.x                     |
|                       (gestucook db only)           |
+--------------------------------|--------------------+
                                 | mongodb://host.docker.internal:27017
                                 v
                      host MongoDB instance
                      (you bring this; we never start one)
```

## Gesture vocabulary

All gesture recognition is client-side via MediaPipe Tasks Vision's GestureRecognizer. The recognizer is calibrated with per-class confidence floors and confirm-frame counts to prevent the closed-fist-reads-as-thumbs-up class of false positive.

| Gesture            | Carousel              | Cooking                            | Trainer  |
|--------------------|-----------------------|------------------------------------|----------|
| Swipe right        | Next recipe           | Next step                          | (n/a)    |
| Swipe left         | Previous recipe       | Previous step                      | (n/a)    |
| Thumbs up          | Start cooking         | Next step / confirm                | Drill    |
| Closed fist        | Back to mode pick     | Exit cooking                       | (n/a)    |
| Open palm          | (n/a)                 | Read current step aloud            | Drill    |
| Open palm (hold)   | (n/a)                 | Lock / unlock sticky step          | (n/a)    |
| Victory (peace)    | Pick recipe for parallel cook | (n/a)                      | Drill    |
| Pointing up        | (n/a)                 | (Ambient mode) exit                | Drill    |

## Voice vocabulary

Always-on during cooking and ambient modes. The mic mutes itself while TTS plays.

| Phrase                              | Action                                   |
|-------------------------------------|------------------------------------------|
| "next" / "forward"                  | Advance one step                         |
| "back" / "previous"                 | Go back one step                         |
| "repeat" / "read it again"          | Re-read current step                     |
| "pause" / "stop"                    | Halt TTS, freeze timer                   |
| "resume" / "continue"               | Resume                                   |
| "kitchen mode" / "ambient"          | Enter Ambient cooking mode               |
| "normal mode"                       | Exit Ambient                             |
| "train" / "practice gestures"      | Open gesture trainer                     |
| "save this" / "snapshot"            | Capture a webcam frame                   |
| "hey gestu, &lt;question&gt;"       | Ask the recipe Q&A (one cheap LLM call)  |

## Features

1. **Auto-extracted step timers.** Step text is regex-scanned for durations at recipe-generation time; the cooking screen counts down and chimes when the timer hits zero.
2. **Voice navigation overlay.** ASR loop during cooking matches a small grammar; mic mutes while TTS plays.
3. **Hands-free recipe Q&A.** "Hey gestu, can I swap butter for oil?" gives a cheap LLM call grounded in the current step, with the answer spoken back. Capped at ~100 in / 60 out tokens.
4. **Auto-pause on hand absence.** If you walk away from camera for 3 seconds, TTS halts mid-sentence and timers freeze. When your hand returns, the step resumes.
5. **Ambient cooking mode.** Voice "kitchen mode" enters a full-bleed large-type single-step view. Read it from across the kitchen.
6. **Sticky step (focus lock).** Open palm held for 1.5s locks the current step against accidental swipes. Same gesture to release, or thumbs up.
7. **Multi-recipe parallel cooking.** Victory-sign two recipes to interleave them by ETA. The app cross-cuts: "while the linguine boils for 8 min, start step 1 of the chickpeas".
8. **Gesture confidence trainer.** A drill mode that shows live recognizer confidence and confirms each gesture with TTS. Persisted to your user record.
9. **Spoken epilogue.** End-of-cook summary: recipe, duration, ingredient count, cents spent, monthly recipes count.
10. **Voice-tagged moments.** Say "save this" to snap a webcam frame keyed to the current step. The epilogue shows a contact sheet.

## Tech stack

| Layer         | Technology                                              |
|---------------|---------------------------------------------------------|
| Frontend      | Vanilla JS modules, CSS variables, MediaPipe Tasks Vision GestureRecognizer (self-hosted) |
| Type          | Fraunces (variable, with italic optical sizing), Geist Sans, Geist Mono (all self-hosted woff2) |
| Backend       | Python, FastAPI, motor 3.x, httpx, tiktoken, Pillow     |
| ASR           | faster-whisper (Whisper tiny, CPU, int8)                |
| TTS           | Piper TTS (en_US-lessac-medium ONNX)                    |
| LLM           | GPT-5.4 Nano (OpenAI, paid) or Gemma 4 31B (OpenRouter, free) |
| Storage       | MongoDB (host instance, `gestucook` DB only); IndexedDB for image blobs |
| Infrastructure| Docker Compose (no Mongo container; uses your host's)   |

## Project structure

```
gestucook/
  .env.example
  docker-compose.yml
  nginx.conf
  README.md
  frontend/
    index.html
    static/
      css/    tokens.css  base.css  components.css  screens.css
      js/     app.js  state.js  api.js  audio.js  voice.js  moments.js  scheduler.js
              gestures.js  sw.js
              ui/        components.js  motion.js  icons.js  diag.js
              screens/   welcome.js  mode.js  photo.js  handsfree.js
                         recipes.js  cooking.js  ambient.js  trainer.js  epilogue.js
      fonts/   fraunces-variable.woff2  fraunces-variable-italic.woff2
               geist-variable.woff2  geist-mono-variable.woff2
      vendor/mediapipe/
               gesture_recognizer.task  vision_bundle.mjs
               wasm/  vision_wasm_internal.{js,wasm}  vision_wasm_nosimd_internal.{js,wasm}
  backend/
    Dockerfile  requirements.txt  main.py  db.py  routes_session.py  routes_qa.py
  asr_service/   Dockerfile  main.py  requirements.txt
  tts_service/   Dockerfile  main.py  requirements.txt
```

## Running it

1. Clone the repo.
2. Make sure your host has a MongoDB container running on `:27017`. We do not spin up a Mongo container; we connect to yours.
3. Copy `.env.example` to `.env` and fill in `OPENROUTER_API_KEY` or `OPENAI_API_KEY`.
4. `docker compose up --build`. First build downloads the Whisper tiny model, the Piper voice, and the MediaPipe assets (~175 MB plus 8 MB).
5. Open `http://localhost:3080`. Allow camera and microphone.

If your host Mongo lives somewhere other than `host.docker.internal:27017`, set `MONGO_URL` in `.env` accordingly.

## Ports

| Service              | Port |
|----------------------|------|
| Frontend (Nginx)     | 3080 |
| Backend (FastAPI)    | 3081 |
| ASR (faster-whisper) | 3082 |
| TTS (Piper)          | 3083 |

## License

MIT.
