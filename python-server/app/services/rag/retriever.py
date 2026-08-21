from typing import Optional

import jieba
from rank_bm25 import BM25Okapi

from app.core.config import SEARCH_COLLECTIONS, CHROMA_USER_UPLOAD_COLLECTION
from app.models.chat import RAGDocument
from app.services.rag.embedding import get_embedding, chroma_client


# ============================================================
# Dense 检索（向量语义）
# ============================================================

def search_docs(query: str, top_k: int = 3) -> list[RAGDocument]:
    """多 collection 向量检索 + 合并排序"""
    query_embedding = get_embedding(query)
    all_docs = []

    for coll_name in SEARCH_COLLECTIONS:
        coll = chroma_client.get_or_create_collection(name=coll_name.strip())
        results = coll.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=["documents", "distances", "metadatas"],
        )
        ids = results.get("ids", [[]])[0]
        docs = results.get("documents", [[]])[0]
        distances = results.get("distances", [[]])[0]
        metadatas_list = results.get("metadatas", [[]])[0] if results.get("metadatas") else []

        for i in range(len(docs)):
            metadata = metadatas_list[i] if i < len(metadatas_list) else None
            all_docs.append(
                RAGDocument(
                    id=ids[i],
                    text=docs[i],
                    distance=distances[i],
                    metadata=metadata,
                )
            )

    all_docs.sort(key=lambda d: d.distance)
    return all_docs[:top_k]


def search_by_file(query: str, file_id: str, top_k: int = 5, user_id: Optional[str] = None) -> list[RAGDocument]:
    """按 file_id 检索用户上传的文档（文件上下文打通）。

    上传流程会把文件分块写入独立的 `rag_user_uploads` collection，
    每块 metadata 带 `file_id` + `user_id`。这里用 ChromaDB 的 where 过滤，
    只召回该文件内与 query 最相关的 chunks。

    多租户隔离：where 同时限定 file_id 和 user_id，防止凭一个 file_id 猜出
    并检索到他人上传的文件内容（IDOR 越权）。
    """
    query_embedding = get_embedding(query)
    coll = chroma_client.get_or_create_collection(name=CHROMA_USER_UPLOAD_COLLECTION)
    # ChromaDB 多条件过滤必须用 $and 组合（不能直接并列多个 key）。
    # 同时限定 file_id + user_id，防止凭 file_id 越权检索他人文件。
    if user_id:
        where: dict = {"$and": [{"file_id": file_id}, {"user_id": user_id}]}
    else:
        where = {"file_id": file_id}
    results = coll.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        where=where,
        include=["documents", "distances", "metadatas"],
    )
    ids = results.get("ids", [[]])[0]
    docs = results.get("documents", [[]])[0]
    distances = results.get("distances", [[]])[0]
    metadatas_list = results.get("metadatas", [[]])[0] if results.get("metadatas") else []

    out = []
    for i in range(len(docs)):
        metadata = metadatas_list[i] if i < len(metadatas_list) else None
        out.append(RAGDocument(id=ids[i], text=docs[i], distance=distances[i], metadata=metadata))

    out.sort(key=lambda d: d.distance)
    return out


# ============================================================
# BM25 稀疏检索（关键词匹配）
# ============================================================

_bm25_corpus = None
_bm25_model = None
_bm25_docs = []
_bm25_ids = []
_bm25_metadata = []


def _init_bm25():
    """从 ChromaDB 加载所有文档，初始化 BM25 模型（服务启动时调用一次）"""
    global _bm25_corpus, _bm25_model, _bm25_docs, _bm25_ids, _bm25_metadata
    _bm25_docs = []
    _bm25_ids = []
    _bm25_metadata = []

    for coll_name in SEARCH_COLLECTIONS:
        coll = chroma_client.get_or_create_collection(name=coll_name.strip())
        results = coll.get(include=["documents", "metadatas"])
        docs = results.get("documents", [])
        ids = results.get("ids", [])
        metadatas = results.get("metadatas", [])

        _bm25_docs.extend(docs)
        _bm25_ids.extend(ids)
        _bm25_metadata.extend(metadatas if metadatas else [None] * len(docs))

    if _bm25_docs:
        _bm25_corpus = []
        for doc in _bm25_docs:
            tokens = list(jieba.cut(doc))
            _bm25_corpus.append(tokens)

        _bm25_model = BM25Okapi(_bm25_corpus)


def sparse_search(query: str, top_k: int = 10) -> list[RAGDocument]:
    """BM25 关键词检索"""
    if _bm25_model is None:
        _init_bm25()

    query_tokens = list(jieba.cut(query))
    # BM25 未初始化（ChromaDB 无数据时）→ 返回空，降级为纯 Dense 检索
    if _bm25_model is None:
        return []
    scores = _bm25_model.get_scores(query_tokens)

    indexed_scores = []
    for i, score in enumerate(scores):
        indexed_scores.append((i, score))

    indexed_scores.sort(key=lambda pair: pair[1], reverse=True)
    top_results = indexed_scores[:top_k]

    result = []
    for i, score in top_results:
        result.append(RAGDocument(
            id=_bm25_ids[i],
            text=_bm25_docs[i],
            score=score,
            metadata=_bm25_metadata[i] if _bm25_metadata else None,
        ))
    return result


# ============================================================
# Min-Max 归一化
# ============================================================

def _normalize(scores: list[float]) -> list[float]:
    """把分数压缩到 0~1 区间"""
    if len(scores) == 0:
        return []

    min_s = min(scores)
    max_s = max(scores)

    if min_s == max_s:
        if max_s > 0:
            return [1.0] * len(scores)
        else:
            return [0.0] * len(scores)

    result = []
    for s in scores:
        normalized = (s - min_s) / (max_s - min_s)
        result.append(normalized)
    return result


# ============================================================
# 方式一：线性加权融合 (hybrid_search)
# ============================================================

def hybrid_search(query: str, alpha: float = 0.7, top_k: int = 5) -> list[RAGDocument]:
    """混合检索（线性加权版）：语义 + 关键词加权融合"""
    dense_results = search_docs(query, top_k=20)
    sparse_results = sparse_search(query, top_k=20)

    text_to_id = {}
    for d in dense_results:
        if d.id:
            text_to_id[d.text] = d.id
    for d in sparse_results:
        if d.id and d.text not in text_to_id:
            text_to_id[d.text] = d.id

    # 对齐
    all_docs: dict[str, dict] = {}
    for d in dense_results:
        all_docs[d.text] = {"dense": 1.0 - (d.distance or 0), "sparse": 0.0}
    for d in sparse_results:
        if d.text in all_docs:
            all_docs[d.text]["sparse"] = d.score or 0.0
        else:
            all_docs[d.text] = {"dense": 0.0, "sparse": d.score or 0.0}

    doc_texts = list(all_docs.keys())

    raw_dense_scores = [all_docs[t]["dense"] for t in doc_texts]
    raw_sparse_scores = [all_docs[t]["sparse"] for t in doc_texts]

    dense_scores = _normalize(raw_dense_scores)
    sparse_scores = _normalize(raw_sparse_scores)

    # 线性加权
    final_scores = []
    for i in range(len(doc_texts)):
        combined = alpha * dense_scores[i] + (1 - alpha) * sparse_scores[i]
        if sparse_scores[i] == 0:
            combined = dense_scores[i] * 0.5
        final_scores.append(combined)

    doc_score_pairs = list(zip(doc_texts, final_scores))
    doc_score_pairs.sort(key=lambda pair: pair[1], reverse=True)

    result = []
    for doc_text, score in doc_score_pairs[:top_k]:
        doc_id = text_to_id.get(doc_text, "")
        result.append(RAGDocument(id=doc_id, text=doc_text, score=round(score, 4)))

    return result


# ============================================================
# 方式二：RRF 排名融合 (hybrid_search_rrf)
# ============================================================

def get_rank(results: list[RAGDocument]) -> dict[str, int]:
    """给检索结果打排名（第1名 = 1，第2名 = 2，...）"""
    rank_dict = {}
    for rank, d in enumerate(results, start=1):
        rank_dict[d.text] = rank
    return rank_dict


def hybrid_search_rrf(query: str, top_k: int = 5, k: int = 60) -> list[RAGDocument]:
    """混合检索（RRF 版）：用排名融合替代分数加权，不需要归一化"""
    dense_results = search_docs(query, top_k=20)
    sparse_results = sparse_search(query, top_k=20)

    text_to_id = {}
    for d in dense_results:
        if d.id:
            text_to_id[d.text] = d.id
    for d in sparse_results:
        if d.id and d.text not in text_to_id:
            text_to_id[d.text] = d.id

    dense_rank = get_rank(dense_results)
    sparse_rank = get_rank(sparse_results)

    all_texts = set(dense_rank.keys()) | set(sparse_rank.keys())
    MISSING_RANK = max(len(dense_rank), len(sparse_rank)) + 1

    rrf_scores = {}
    for text in all_texts:
        rrf_scores[text] = (
            1.0 / (k + dense_rank.get(text, MISSING_RANK))
            + 1.0 / (k + sparse_rank.get(text, MISSING_RANK))
        )

    sorted_items = sorted(rrf_scores.items(), key=lambda p: p[1], reverse=True)
    top_items = sorted_items[:top_k]

    result = []
    for text, score in top_items:
        doc_id = text_to_id.get(text, "")
        result.append(RAGDocument(id=doc_id, text=text, score=round(score, 6)))

    return result
