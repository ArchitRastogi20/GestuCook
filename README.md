# GestuCook

A non-WIMP cooking interface. Voice, gesture, and audio carry the entire cooking flow: no clicks, no scrolls, hands stay on the food.

## What it does

You arrive at the welcome screen, pick a language, and type your name once. New cooks are walked through a short gesture trainer before their first recipe; after that the app is gesture-first and voice-second:

1. **Pick a mode.** Photo (upload images of ingredients) or hands-free (speak them).
2. **The LLM identifies ingredients and proposes 2-3 recipes.** Gemma 4 31B (OpenRouter, free) or GPT-5.4 Nano (OpenAI) depending on your `.env`.
3. **Browse recipes by swiping your hand.** The featured card sits in a tactile bezel; the other recipes cascade behind it. Thumbs up to start cooking, fist to go back.
4. **Cook step by step.** Steps with embedded durations get an automatic countdown timer. Open palm to read the current step aloud. Swipe to advance.
5. **Speak to navigate.** Say "next", "back", "repeat", or "pause". Say "save this" to keep a webcam frame of the dish. Say "kitchen mode" to enter the large-distance reading view.
6. **Ask a question, hands-free.** Make a peace sign (or say "question") to open a short listening window, ask something like "can I use spaghetti instead?", and hear a bounded answer spoken back.
7. **At the end**, you hear a spoken epilogue: what you cooked, how long it took, how much the LLM cost in cents, and how many recipes you've cooked this month.

The whole flow runs in English, Hindi, Italian, or Spanish: the UI, the generated recipes, the voice command grammar, and the spoken answers all follow the language you pick.

## The non-WIMP thesis

The point of GestuCook is to study how a multimodal interface works when the user's hands are busy. Every feature has to lean on voice, gesture, or audio, not on adding buttons.

## Architecture

Four Docker services, plus the browser doing the gesture and voice work.

```
Browser
  + Gallery UI (Fraunces, Geist, Geist Mono; system Noto Devanagari for Hindi)
  + Single input arbiter (commands.js): gesture + voice + button + timer,
      one global cooldown so two modalities can't double-fire one intent
  + Always-on voice command loop (commands only; questions are gesture-gated)
  + MediaPipe Tasks Vision landmarks -> geometric pose classifier
      + One-Euro smoothing + wrist-trajectory swipe layer
  + IndexedDB for voice-tagged moments
  + localStorage for name, language, and the onboarding flag
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

When `AUDIO_PROVIDER=openai`, the backend's `/api/asr` and `/api/tts` routes proxy to the OpenAI audio APIs instead of the ASR and TTS containers. The containers are only used in the default local audio stack.

## Gesture recognition

All gesture recognition is client-side. MediaPipe Tasks Vision supplies the 21 hand landmarks; GestuCook classifies the pose itself, geometrically, from finger curl and extend angles, so the same landmarks always produce the same label. A pose must be held steadily for about 350 ms to fire (time-based, so it behaves the same at 8 fps on a slow CPU or 60 fps), the landmark stream is de-noised with a One-Euro filter, and a wrist-trajectory layer handles swipes. This replaces gating on MediaPipe's jittery confidence score, which used to make thumbs-up unreliable.

## Gesture vocabulary

Gesture meaning is per-screen. A held pose fires once and will not repeat until the hand relaxes to neutral.

| Gesture                | Recipe carousel               | Cooking                      | Kitchen mode (ambient)     |
|------------------------|-------------------------------|------------------------------|----------------------------|
| Swipe right            | Next recipe                   | Next step                    | Next step                  |
| Swipe left             | Previous recipe               | Previous step                | Previous step              |
| Thumbs up              | Start cooking (both, if two picked) | Next step              | Next step                  |
| Closed fist            | Back to mode pick             | Exit to recipes              | Exit to standard cooking   |
| Open palm              | (n/a)                         | Read current step aloud      | (n/a)                      |
| Open palm (hold ~1.2s) | (n/a)                         | Lock / unlock the step       | (n/a)                      |
| Peace sign             | Pick recipe (for parallel cook) | Ask a question (Q&A)       | Ask a question (Q&A)       |
| Point up               | (n/a)                         | (n/a)                        | Exit kitchen mode          |

The first-run gesture trainer drills five of these: thumbs up, closed fist, open palm, peace sign, and point up.

## Voice vocabulary

The command loop is always on during cooking and kitchen (ambient) mode, capturing short chunks and matching a tiny grammar. The mic mutes itself while TTS plays. Anything that is not a command is ignored: spoken questions go through the gesture-gated Q&A window, not this loop. The grammar is matched in English and, additionally, in the session language.

| Phrase                              | Action                                   |
|-------------------------------------|------------------------------------------|
| "next" / "forward" / "continue"     | Advance one step                         |
| "back" / "previous"                 | Go back one step                         |
| "repeat" / "again"                  | Re-read current step                     |
| "pause" / "stop"                    | Halt TTS, freeze timer                   |
| "resume" / "continue"               | Resume                                   |
| "question" / "ask" / "hey chef"     | Open the Q&A listening window            |
| "kitchen mode" / "ambient"          | Enter kitchen (ambient) mode             |
| "normal mode"                       | Exit kitchen mode                        |
| "train" / "practice gestures"       | Open the gesture trainer                 |
| "save this" / "snapshot"            | Capture a webcam frame                   |

## Features

1. **Single input arbiter.** Every gesture, voice command, button, and timer routes through one debounced dispatcher with a global cooldown, so a gesture and the voice loop hearing the same moment can't skip a step between them.
2. **Auto-extracted step timers.** Step text is scanned for durations at recipe-generation time; the cooking screen counts down and chimes when the timer hits zero. The parser recognises localized time words ("per 4 minuti", localized minute and hour units), so timers work in every supported language.
3. **Always-on voice commands.** A short-chunk ASR loop during cooking and kitchen mode matches a small grammar; the mic mutes while TTS plays so the speaker can't echo into the recogniser.
4. **Gesture-gated hands-free Q&A.** A peace sign (or the "question" command) opens a fixed ~5.5s listening window: an earcon sounds, you ask one question, it is transcribed and answered aloud, then the window closes on its own. Answers are grounded in the current recipe and step and bounded to about two short sentences. A per-session toggle turns the feature off.
5. **Auto-pause on hand absence.** If you leave the camera for about 3 seconds, TTS halts mid-sentence and timers freeze. Any input wakes it and the step resumes.
6. **Kitchen (ambient) mode.** A full-bleed, large-type single-step view. Read it from across the kitchen.
7. **Sticky step (focus lock).** Open palm held for ~1.2s locks the current step against accidental swipes. Same gesture to release, or thumbs up.
8. **Multi-recipe parallel cooking.** Peace-pick two recipes on the carousel, then thumbs up to cook both. The app interleaves them by ETA and cross-cuts between the two lanes.
9. **Gesture trainer and first-run onboarding.** A drill mode that shows live recognizer confidence and confirms each gesture with TTS. New users go through it before their first cook; the result is persisted to the user record.
10. **Spoken epilogue.** End-of-cook summary: recipe, duration, ingredient count, cents spent, monthly recipe count.
11. **Voice-tagged moments.** Say "save this" to snap a webcam frame keyed to the current step. The epilogue shows a contact sheet.
12. **Multilingual.** English, Hindi, Italian, and Spanish across the UI, the generated recipes, the voice command grammar, and the spoken answers. Non-English sessions require the OpenAI audio provider (see below).

## Tech stack

| Layer         | Technology                                              |
|---------------|---------------------------------------------------------|
| Frontend      | Vanilla JS modules, single command arbiter, CSS variables, MediaPipe Tasks Vision (self-hosted) — geometric pose classifier with One-Euro smoothing |
| Type          | Fraunces (variable, with italic optical sizing), Geist Sans, Geist Mono (self-hosted woff2); system Noto Devanagari as the Hindi fallback |
| Languages     | English, Hindi, Italian, Spanish (UI, recipes, voice grammar, Q&A) |
| Backend       | Python, FastAPI, motor 3.x, httpx, tiktoken, Pillow     |
| LLM           | GPT-5.4 Nano (OpenAI, paid) or Gemma 4 31B (OpenRouter, free) |
| Audio         | Local: faster-whisper (Whisper tiny, CPU, int8) + Piper (en_US-lessac-medium ONNX). OpenAI: gpt-4o-mini-transcribe + gpt-4o-mini-tts (required for non-English) |
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
      js/     app.js  state.js  api.js  audio.js  voice.js  qa.js
              commands.js  i18n.js  moments.js  scheduler.js
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
    Dockerfile  requirements.txt  main.py  db.py  langs.py  routes_session.py  routes_qa.py
  asr_service/   Dockerfile  main.py  requirements.txt
  tts_service/   Dockerfile  main.py  requirements.txt
```

## Running it

1. Clone the repo.
2. Make sure your host has a MongoDB instance running on `:27017`. We do not spin up a Mongo container; we connect to yours.
3. Copy `.env.example` to `.env`. Set `LLM_PROVIDER` and the matching API key (`OPENROUTER_API_KEY` or `OPENAI_API_KEY`). For Hindi, Italian, or Spanish sessions, set `AUDIO_PROVIDER=openai` — the local Piper and Whisper stack is English-only, so non-English audio is served by the OpenAI audio APIs and needs `OPENAI_API_KEY`.
4. `docker compose up --build`. The first build of the local audio stack downloads the Whisper tiny model, the Piper voice, and the MediaPipe assets (~175 MB plus 8 MB).
5. Open `http://localhost:3080`. Allow camera and microphone.

If your host Mongo lives somewhere other than `host.docker.internal:27017`, set `MONGO_URL` in `.env` accordingly.

## Ports

| Service              | Port | Notes                                  |
|----------------------|------|----------------------------------------|
| Frontend (Nginx)     | 3080 |                                        |
| Backend (FastAPI)    | 3081 |                                        |
| ASR (faster-whisper) | 3082 | local audio stack only                 |
| TTS (Piper)          | 3083 | local audio stack only                 |

## License

MIT.
