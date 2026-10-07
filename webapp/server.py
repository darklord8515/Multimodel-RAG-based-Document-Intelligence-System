"""FastAPI app: upload documents, track ingestion, ask questions."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import QUERY_MODES, LLM_MODEL, Engine
from .parsing import SUPPORTED_EXTS

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))
STATIC_DIR = Path(__file__).parent / "static"
ASSETS_DIR = Path(__file__).parent.parent / "assets"

engine = Engine()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await engine.start()
    yield
    await engine.stop()


app = FastAPI(title="RAG-Anything", lifespan=lifespan)


class AskBody(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    mode: str = "mix"


@app.get("/api/health")
async def health():
    return {
        "ready": engine.ready,
        "error": engine.init_error,
        "model": LLM_MODEL,
        "extensions": sorted(SUPPORTED_EXTS),
        "max_upload_mb": MAX_UPLOAD_MB,
        "modes": QUERY_MODES,
    }


@app.get("/api/documents")
async def documents():
    return engine.list_docs()


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...)):
    if not engine.ready:
        raise HTTPException(503, engine.init_error or "Engine is not ready")
    accepted, rejected = [], []
    for f in files:
        name = Path(f.filename or "file").name
        ext = Path(name).suffix.lower()
        if ext not in SUPPORTED_EXTS:
            rejected.append({"name": name, "reason": f"Unsupported type {ext or '(none)'}"})
            continue
        data = await f.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
        if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
            rejected.append({"name": name, "reason": f"Larger than {MAX_UPLOAD_MB} MB"})
            continue
        if not data:
            rejected.append({"name": name, "reason": "File is empty"})
            continue
        accepted.append(engine.enqueue(name, data).__dict__)
    return {"accepted": accepted, "rejected": rejected}


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    if not await engine.delete(doc_id):
        raise HTTPException(404, "Document not found")
    return {"ok": True}


@app.post("/api/documents/{doc_id}/retry")
async def retry_document(doc_id: str):
    if not engine.retry(doc_id):
        raise HTTPException(409, "Only failed documents can be retried")
    return {"ok": True}


@app.post("/api/query")
async def query(body: AskBody):
    mode = body.mode if body.mode in QUERY_MODES else "mix"
    try:
        answer = await engine.ask(body.question.strip(), mode)
    except LookupError as e:
        raise HTTPException(409, str(e))
    except Exception as e:
        raise HTTPException(502, f"The model request failed: {e}")
    return {"answer": answer}


app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
