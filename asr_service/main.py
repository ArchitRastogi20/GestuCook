import os
import tempfile
from fastapi import FastAPI, UploadFile, File
from faster_whisper import WhisperModel

app = FastAPI(title="GestuCook ASR")

MODEL_SIZE = os.getenv("ASR_MODEL", "tiny")
model = None


@app.on_event("startup")
def load_model():
    global model
    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    contents = await audio.read()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(contents)
        tmp_path = f.name

    try:
        segments, info = model.transcribe(tmp_path, beam_size=5)
        text = " ".join([seg.text.strip() for seg in segments])
    finally:
        os.unlink(tmp_path)

    return {
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
    }


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_SIZE}
