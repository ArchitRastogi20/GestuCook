import io
import wave
from fastapi import FastAPI, Form
from fastapi.responses import Response
from piper import PiperVoice

app = FastAPI(title="GestuCook TTS")

VOICE_PATH = "/models/piper/en_US-lessac-medium.onnx"
voice = None


@app.on_event("startup")
def load_voice():
    global voice
    voice = PiperVoice.load(VOICE_PATH)


@app.post("/speak")
async def speak(text: str = Form(...)):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        voice.synthesize(text, wav)
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


@app.get("/health")
async def health():
    return {"status": "ok"}
