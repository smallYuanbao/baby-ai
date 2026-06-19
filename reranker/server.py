"""
BGE Reranker 服务 — 基于 FlagEmbedding + BAAI/bge-reranker-v2-m3
=================================================================

What this service does:
  Accepts a query + candidate document list, scores each document's relevance to the
  query with a cross-encoder model, and returns the top-k documents in descending
  score order.  It exposes two HTTP endpoints: a health check and the /rerank route.

Prerequisites / Dependencies:
  - Python 3.9+
  - PyTorch (GPU recommended; CUDA-capable device if use_fp16=True)
  - FlagEmbedding  (pip install FlagEmbedding)
  - FastAPI + uvicorn (pip install fastapi uvicorn)
  - The model "BAAI/bge-reranker-v2-m3" is downloaded automatically on first launch
    and cached by Hugging Face Hub (~2.2 GB disk, ~4 GB GPU memory).

How to run:
  # directly (development)
  python server.py

  # or via uvicorn (production)
  uvicorn server:app --host 0.0.0.0 --port 8001 --workers 1

  Note: --workers > 1 is NOT recommended because the model is loaded once in
  global memory; multiple workers would each load their own copy.

API overview:
  GET  /health          → {"status": "ok", "model": "...", "loaded": true}
  POST /rerank          → {"results": [{"id": "...", "score": 0.9876}, ...], "model": "..."}

  Request body for /rerank:
    {
      "query": "你的搜索查询",
      "documents": [{"id": "d1", "text": "候选文档1"}, ...],
      "top_k": 4            // optional, default 4, range [1, 50]
    }

  Response body for /rerank:
    {
      "results": [
        {"id": "d1", "score": 0.987654},
        {"id": "d3", "score": 0.123456}
      ],
      "model": "BAAI/bge-reranker-v2-m3"
    }

Edge cases handled:
  - Empty documents list  → returns empty results immediately (200 OK, not 4xx).
  - Model not yet loaded   → 503 Service Unavailable with detail message.
  - Single document input  → compute_score returns a float (not a list); normalized
    to a list for uniform downstream sorting.
  - top_k > len(documents) → returns all ranked documents (capped implicitly by
    slicing ranked[:req.top_k] which Python handles safely).
  - FP16 on CPU devices    → FlagEmbedding will fall back to FP32 automatically
    (no explicit fallback in this file; handled inside FlagReranker).
  - Rounding               → scores are rounded to 6 decimal places for readability
    and to avoid floating-point noise in JSON output.
  - Thread safety          → The global reranker instance is read-only after startup
    and safe for concurrent requests (no mutable shared state).  FastAPI's async
    handlers work because compute_score is CPU-bound; for high throughput consider
    wrapping in run_in_executor.

Request lifecycle (step-by-step):
  1. Client sends POST /rerank with JSON body.
  2. FastAPI validates the body against RerankRequest (Pydantic).
  3. Handler checks that the global reranker model is loaded (else 503).
  4. Handler checks for empty documents (early return, no model call).
  5. Build (query, doc_text) pairs for the cross-encoder.
  6. Call reranker.compute_score(pairs, normalize=True) — returns scores in [0, 1].
  7. Normalise single float to list (edge case: only 1 document).
  8. Zip scores with documents, sort descending by score.
  9. Slice top_k results, round scores to 6 decimal places.
  10. Log the request summary (truncated query, doc count, top scores).
  11. Return RerankResponse (Pydantic serialised to JSON).
"""

import logging
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from FlagEmbedding import FlagReranker

# --------------- Logging setup ---------------
# Use basicConfig for simplicity; in production a JSON formatter or
# structured-logging library would be preferred for log aggregation.
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s")
logger = logging.getLogger("reranker")

# --------------- Model identifier ---------------
# BAAI/bge-reranker-v2-m3 is a multilingual cross-encoder reranker.
# It takes a (query, document) pair and outputs a single relevance score in [0, 1].
# The model is ~568M parameters; with FP16 it needs roughly 2.2 GB GPU VRAM.
MODEL_NAME = "BAAI/bge-reranker-v2-m3"

# --------------- Global model handle ---------------
# Loaded once at startup via the lifespan context manager and shared across
# all requests.  The Optional flag lets the health endpoint detect whether
# the model has finished loading (or failed to load).
reranker: Optional[FlagReranker] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan context manager.

    Called once at application startup (before the first request is accepted)
    and once at shutdown.  Loads the BGE reranker model into GPU memory on
    startup and releases it on shutdown.

    Startup:
      - Downloads the model from Hugging Face Hub if not cached locally.
      - Instantiates FlagReranker with use_fp16=True to reduce GPU memory.
      - Logs progress so operators can see if the model is stuck downloading.

    Shutdown:
      - Deletes the global reranker instance to free GPU memory.
      - Logs the teardown so it is visible in server logs.
    """
    global reranker
    logger.info(f"加载模型: {MODEL_NAME}")
    # use_fp16=True 节省显存，推理也更快
    # If no GPU is available, FlagEmbedding internally falls back to FP32 on CPU.
    reranker = FlagReranker(MODEL_NAME, use_fp16=True)
    logger.info("模型加载完成 ✅")
    yield  # The application runs while suspended at yield.
    # ---- shutdown phase (after yield) ----
    logger.info("释放资源")
    if reranker:
        del reranker


# --------------- FastAPI application ---------------
# The lifespan parameter defers model loading until uvicorn is ready.
app = FastAPI(title="BGE Reranker Service", version="1.0.0", lifespan=lifespan)


# ================================================================
#  Pydantic Schemas — define the shape of request / response data.
#  These serve as both validation and auto-generated OpenAPI docs.
# ================================================================


class DocumentInput(BaseModel):
    """
    A single candidate document to be scored against the query.

    Attributes:
        id (str): Unique identifier for this document (e.g. chunk UUID).
                  Returned verbatim in the response so the caller can map
                  scores back to their original dataset.
        text (str): The full text of the document/chunk.  There is no hard
                    character limit in this service, but the underlying BGE
                    model has a maximum input length of 8192 tokens; longer
                    texts will be truncated by the tokenizer.
    """
    id: str
    text: str


class RerankRequest(BaseModel):
    """
    Incoming request body for the /rerank endpoint.

    Attributes:
        query (str): The search query or question text.
        documents (List[DocumentInput]): Candidate documents to rank.
            May be empty (returns empty results).
        top_k (int): Number of top-scoring documents to return.
            Default 4, clamped to [1, 50] by Pydantic validation.
            Values outside this range trigger a 422 validation error.
    """
    query: str
    documents: List[DocumentInput]
    top_k: int = Field(default=4, ge=1, le=50)


class RerankResultItem(BaseModel):
    """
    A single ranked result containing the original document ID and its score.

    Attributes:
        id (str): The document's original ID (echoed from input).
        score (float): Relevance score in [0, 1], higher is more relevant.
            The score comes from the cross-encoder's sigmoid output and is
            rounded to 6 decimal places to reduce JSON noise.
    """
    id: str
    score: float


class RerankResponse(BaseModel):
    """
    Response body for the /rerank endpoint.

    Attributes:
        results (List[RerankResultItem]): Ranked list (descending score),
            length ≤ top_k.  Empty if no documents were supplied.
        model (str): The model name used for scoring, included so clients
            can verify which model produced the scores.
    """
    results: List[RerankResultItem]
    model: str = MODEL_NAME


# ================================================================
#  Routes
# ================================================================


@app.get("/health")
async def health():
    """
    Health-check endpoint.

    Returns:
        dict with keys:
          - status (str): "ok" when the server is reachable.
          - model (str): The configured model name.
          - loaded (bool): Whether the reranker model has finished loading.
            During the initial download period this will be False; clients
            should wait and retry before sending rerank requests.

    This endpoint is lightweight (no model inference) and suitable for
    Kubernetes liveness/readiness probes or load-balancer health checks.
    """
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "loaded": reranker is not None,
    }


@app.post("/rerank", response_model=RerankResponse)
async def rerank(req: RerankRequest):
    """
    Score and rank candidate documents against a query.

    Args:
        req (RerankRequest): The request body containing the query string,
            a list of DocumentInput objects, and an optional top_k.

    Returns:
        RerankResponse: Top-k documents sorted by descending relevance score.

    Raises:
        HTTPException (503): If the model has not finished loading yet.
            Clients should back off and retry after a few seconds.

    Edge cases handled in this method:
        - Empty `documents` → returns RerankResponse(results=[]) with 200 OK.
        - Single document → `compute_score` returns a bare float; this method
          wraps it into a list so the downstream sort/zips work uniformly.
        - top_k > number of documents → returns all ranked documents; Python
          slicing `ranked[: req.top_k]` handles out-of-range gracefully.

    Logging:
        Each request logs (at INFO level) the first 50 characters of the
        query, the number of documents submitted, and the top-k scores.
        This is useful for debugging ranking quality in production.
    """
    # Guard: model must be loaded before any inference can run.
    if reranker is None:
        raise HTTPException(status_code=503, detail="模型尚未加载")

    # Early return: empty document list — no scoring work to do.
    if not req.documents:
        return RerankResponse(results=[])

    # Build [[query, doc_text], ...] pairs for the cross-encoder.
    # The BGE reranker expects a list of [query, document] pairs.
    # Each pair is fed through the model separately (it is a cross-encoder,
    # not a bi-encoder), so inference cost scales O(N) with N documents.
    pairs = [[req.query, doc.text] for doc in req.documents]

    # compute_score returns a relevance score in [0, 1] for each pair.
    # `normalize=True` applies a sigmoid so the raw logits map to [0, 1].
    #   0.0 = completely irrelevant, 1.0 = perfect match.
    # When called with a single pair, the return type is `float` (not list).
    # When called with multiple pairs, the return type is `list[float]`.
    # We normalise the single-float case below so downstream logic is uniform.
    scores = reranker.compute_score(pairs, normalize=True)

    # Normalise: if only one document was scored, wrap the bare float in a list.
    if not isinstance(scores, list):
        scores = [scores]

    # Sort document-score pairs in descending order by score.
    # zip() pairs each original DocumentInput with its computed score.
    ranked = sorted(
        zip(req.documents, scores),
        key=lambda x: x[1],
        reverse=True,
    )

    # Select the top_k results and build response objects.
    # Scores are rounded to 6 decimal places:
    #   - Avoids floating-point artifacts like 0.12345600000001 in JSON.
    #   - 6 decimal places is more than enough precision for ranking decisions.
    # Python slicing handles the case where top_k > len(ranked) safely.
    top_results = [
        RerankResultItem(id=doc.id, score=round(float(score), 6))
        for doc, score in ranked[: req.top_k]
    ]

    # Log a summary line for monitoring and debugging.
    # Query is truncated to 50 characters to avoid bloating logs with long queries.
    logger.info(
        f"query='{req.query[:50]}' "
        f"docs={len(req.documents)} → top_{req.top_k} "
        f"scores=[{', '.join(f'{r.score:.4f}' for r in top_results)}]"
    )

    return RerankResponse(results=top_results)


# --------------- Direct-run entry point ---------------
# Allows `python server.py` without an external ASGI runner.
# For production, prefer `uvicorn server:app` with a process manager (e.g.
# gunicorn with uvicorn workers, or systemd).
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
