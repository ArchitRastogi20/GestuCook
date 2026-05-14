// frontend/static/js/moments.js
// IndexedDB store for voice-tagged moments. Blob storage only; metadata lives in mongo events.

const DB_NAME = "gestucook";
const STORE = "moments";

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("by_session", "session_id", { unique: false });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function saveMoment(session_id, step_num, blob) {
  const db = await openDB();
  const id = `${session_id}:${step_num}:${Date.now()}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add({ id, session_id, step_num, ts: Date.now(), blob });
    tx.oncomplete = () => resolve(id);
    tx.onerror    = () => reject(tx.error);
  });
}

export async function loadMoments(session_id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE, "readonly");
    const idx = tx.objectStore(STORE).index("by_session");
    const req = idx.openCursor(IDBKeyRange.only(session_id));
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else { out.sort((a, b) => a.step_num - b.step_num || a.ts - b.ts); resolve(out); }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function captureFrame(videoEl) {
  const w = videoEl.videoWidth, h = videoEl.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(videoEl, 0, 0, w, h);
  return await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.82));
}
