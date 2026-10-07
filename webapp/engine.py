"""RAG engine: wires RAG-Anything to Groq (LLM/vision) and local embeddings."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from functools import partial
from pathlib import Path

import numpy as np
from openai import RateLimitError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_random_exponential
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env", override=False)

from lightrag.llm.openai import openai_complete_if_cache  # noqa: E402
from lightrag.utils import EmbeddingFunc, logger  # noqa: E402

from raganything import RAGAnything, RAGAnythingConfig  # noqa: E402

from .parsing import to_content_list  # noqa: E402

DATA_DIR = Path(os.getenv("DATA_DIR", "./data")).resolve()
UPLOAD_DIR = DATA_DIR / "uploads"
STORAGE_DIR = DATA_DIR / "rag_storage"
REGISTRY = DATA_DIR / "documents.json"

API_KEY = os.getenv("LLM_BINDING_API_KEY", "")
BASE_URL = os.getenv("LLM_BINDING_HOST", "https://api.groq.com/openai/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "openai/gpt-oss-120b")
VISION_MODEL = os.getenv("VISION_MODEL", "qwen/qwen3.8-27b")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "384"))

QUERY_MODES = ("mix", "hybrid", "local", "global", "naive")


# Groq's free tier answers 429 with 20-40s waits; LightRAG's own retry gives up
# after ~10s, which fails the whole document. Back off much longer here.
_patient = retry(
    retry=retry_if_exception_type(RateLimitError),
    wait=wait_random_exponential(multiplier=5, min=10, max=90),
    stop=stop_after_attempt(int(os.getenv("RATE_LIMIT_RETRIES", "8"))),
    reraise=True,
)


_embedder = None
_embed_lock = threading.Lock()


def _embed_sync(texts: list[str]) -> np.ndarray:
    # Loaded lazily: the ONNX model takes a moment to initialise.
    global _embedder
    with _embed_lock:
        if _embedder is None:
            from fastembed import TextEmbedding

            _embedder = TextEmbedding(model_name=EMBEDDING_MODEL)
        return np.array(list(_embedder.embed(texts)), dtype=np.float32)


# Module-level (not a bound method): LightRAG deep-copies its config, which
# would fail on an object holding locks/queues.
async def _embed(texts: list[str]) -> np.ndarray:
    return await asyncio.to_thread(_embed_sync, texts)


@dataclass
class DocRecord:
    id: str
    name: str
    size: int
    status: str = "queued"  # queued | processing | ready | error
    error: str | None = None
    added: float = field(default_factory=time.time)


class Engine:
    def __init__(self) -> None:
        self.docs: dict[str, DocRecord] = {}
        self.rag: RAGAnything | None = None
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self.ready = False
        self.init_error: str | None = None

    # ---- lifecycle -------------------------------------------------------
    async def start(self) -> None:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        self._load_registry()
        if not API_KEY:
            self.init_error = "LLM_BINDING_API_KEY is not set (see .env.example)."
            return
        try:
            self.rag = self._build_rag()
            # Files are parsed by webapp.parsing, so MinerU is not required.
            self.rag._parser_installation_checked = True
            await self.rag._ensure_lightrag_initialized()
            if self.rag.lightrag is None:
                raise RuntimeError("LightRAG failed to initialize; see server log")
            self.ready = True
        except Exception as e:  # surface in /api/health instead of crashing
            logger.exception("Engine init failed")
            self.init_error = str(e)
            return
        # Anything left unfinished from a previous run goes back in the queue.
        for rec in self.docs.values():
            if rec.status in ("queued", "processing"):
                rec.status = "queued"
                self.queue.put_nowait(rec.id)
        self._worker = asyncio.create_task(self._run_worker())

    async def stop(self) -> None:
        if self._worker:
            self._worker.cancel()
        if self.rag:
            try:
                await self.rag.finalize_storages()
            except Exception:
                logger.exception("finalize_storages failed")

    # ---- model plumbing --------------------------------------------------
    def _build_rag(self) -> RAGAnything:
        extra = {"max_tokens": int(os.getenv("MAX_OUTPUT_TOKENS", "2000"))}
        if "gpt-oss" in LLM_MODEL:
            extra["reasoning_effort"] = "low"

        @_patient
        async def llm(prompt, system_prompt=None, history_messages=None, **kwargs):
            return await openai_complete_if_cache(
                LLM_MODEL,
                prompt,
                system_prompt=system_prompt,
                history_messages=history_messages or [],
                api_key=API_KEY,
                base_url=BASE_URL,
                **{**extra, **kwargs},
            )

        @_patient
        async def vision(prompt, system_prompt=None, history_messages=None, image_data=None, messages=None, **kwargs):
            if messages:
                return await openai_complete_if_cache(
                    VISION_MODEL, "", messages=messages, api_key=API_KEY, base_url=BASE_URL, **kwargs
                )
            if image_data:
                msgs = []
                if system_prompt:
                    msgs.append({"role": "system", "content": system_prompt})
                msgs.append(
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_data}"}},
                        ],
                    }
                )
                return await openai_complete_if_cache(
                    VISION_MODEL, "", messages=msgs, api_key=API_KEY, base_url=BASE_URL, **kwargs
                )
            return await llm(prompt, system_prompt, history_messages, **kwargs)

        embedding = EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=512,
            func=_embed,
        )
        config = RAGAnythingConfig(
            working_dir=str(STORAGE_DIR),
            parser_output_dir=str(DATA_DIR / "parsed"),
            enable_image_processing=True,
            enable_table_processing=True,
            enable_equation_processing=False,
        )
        return RAGAnything(
            config=config,
            llm_model_func=llm,
            vision_model_func=vision,
            embedding_func=embedding,
            lightrag_kwargs={
                # Groq's free tier is rate limited; keep concurrency modest.
                "llm_model_max_async": int(os.getenv("LLM_MAX_ASYNC", "1")),
                "chunk_token_size": int(os.getenv("CHUNK_TOKEN_SIZE", "500")),
                # Groq free tier: 8000 tokens/min per model, so keep every request small.
                "entity_extract_max_gleaning": 0,
                "max_total_tokens": int(os.getenv("MAX_CONTEXT_TOKENS", "4000")),
            },
        )

    # ---- registry --------------------------------------------------------
    def _load_registry(self) -> None:
        if REGISTRY.exists():
            try:
                self.docs = {d["id"]: DocRecord(**d) for d in json.loads(REGISTRY.read_text("utf-8"))}
            except (ValueError, TypeError, KeyError):
                logger.warning("Could not read documents.json; starting empty")

    def _save_registry(self) -> None:
        tmp = REGISTRY.with_suffix(".tmp")
        tmp.write_text(json.dumps([asdict(d) for d in self.docs.values()], indent=2), "utf-8")
        tmp.replace(REGISTRY)

    def list_docs(self) -> list[dict]:
        return [asdict(d) for d in sorted(self.docs.values(), key=lambda d: d.added, reverse=True)]

    # ---- ingestion -------------------------------------------------------
    def stored_path(self, rec: DocRecord) -> Path:
        return UPLOAD_DIR / f"{rec.id}{Path(rec.name).suffix.lower()}"

    def enqueue(self, name: str, data: bytes) -> DocRecord:
        rec = DocRecord(id=f"doc-{uuid.uuid4().hex[:16]}", name=name, size=len(data))
        self.stored_path(rec).write_bytes(data)
        self.docs[rec.id] = rec
        self._save_registry()
        self.queue.put_nowait(rec.id)
        return rec

    async def _run_worker(self) -> None:
        while True:
            doc_id = await self.queue.get()
            rec = self.docs.get(doc_id)
            if rec is None:
                continue
            rec.status, rec.error = "processing", None
            self._save_registry()
            try:
                path = self.stored_path(rec)
                content = await asyncio.to_thread(to_content_list, path)
                await self.rag.insert_content_list(content, file_path=rec.name, doc_id=rec.id)
                rec.status = "ready"
            except Exception as e:
                logger.exception("Ingestion failed for %s", rec.name)
                rec.status, rec.error = "error", str(e)[:500]
            self._save_registry()

    def retry(self, doc_id: str) -> bool:
        rec = self.docs.get(doc_id)
        if rec is None or rec.status != "error" or not self.stored_path(rec).exists():
            return False
        rec.status, rec.error = "queued", None
        self._save_registry()
        self.queue.put_nowait(rec.id)
        return True

    async def delete(self, doc_id: str) -> bool:
        rec = self.docs.pop(doc_id, None)
        if rec is None:
            return False
        if rec.status == "ready" and self.rag:
            try:
                await self.rag.lightrag.adelete_by_doc_id(doc_id)
            except Exception:
                logger.exception("Could not remove %s from the index", doc_id)
        self.stored_path(rec).unlink(missing_ok=True)
        self._save_registry()
        return True

    # ---- querying --------------------------------------------------------
    async def ask(self, question: str, mode: str = "mix") -> str:
        if not self.ready:
            raise RuntimeError(self.init_error or "Engine is not ready")
        if not any(d.status == "ready" for d in self.docs.values()):
            raise LookupError("Upload at least one document first.")
        return await self.rag.aquery(question, mode=mode, vlm_enhanced=False)
