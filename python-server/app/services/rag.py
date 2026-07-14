import chromadb
from chromadb.config import Settings
from app.core.config import CHROMA_HOST, CHROMA_PORT, SEARCH_COLLECTIONS, OLLAMA_BASE_URL, OLLAMA_PORT, OLLAMA_MODEL

import jieba
from rank_bm25 import BM25Okapi

# 初始化 chroma client（连接 Docker ChromaDB）
chroma_client = chromadb.HttpClient(
    host=CHROMA_HOST,
    port=CHROMA_PORT,
    settings=Settings(anonymized_telemetry=False),
)


def get_embedding(text: str) -> list[float]:
    """调用 Ollama 的 bge-m3 模型生成向量"""
    import requests
    response = requests.post(
        f"http://{OLLAMA_BASE_URL}:{OLLAMA_PORT}/api/embed",
        json={"model": OLLAMA_MODEL, "input": [text]},
    )
    response.raise_for_status()
    return response.json()["embeddings"][0]


def search_docs(query: str, top_k: int = 3) -> list[tuple[str, float]]:
    """多 collection 向量检索 + 合并排序，返回 [(文档内容, 距离), ...]"""
    query_embedding = get_embedding(query)
    all_docs = []

    for coll_name in SEARCH_COLLECTIONS:
        coll = chroma_client.get_or_create_collection(name=coll_name.strip())
        results = coll.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=["documents", "distances"],
        )
        docs = results.get("documents", [[]])[0]
        distances = results.get("distances", [[]])[0]
        for doc, dist in zip(docs, distances):
            all_docs.append((doc, dist))

    # 按距离升序（距离越小越相关）
    all_docs.sort(key=lambda pair: pair[1])

    # 取 top_k，同时把距离转为相似度（1 - 距离），这样分数越大越好
    result = []
    for doc, dist in all_docs[:top_k]:
        similarity = 1.0 - dist  # 余弦距离 → 相似度，现在越大越好
        result.append((doc, similarity))
    return result


# ============================================================
# BM25 稀疏检索（关键词匹配）
# ============================================================

_bm25_corpus = None
_bm25_model = None
_bm25_docs = []


def _init_bm25():
    """从 ChromaDB 加载所有文档，初始化 BM25 模型（服务启动时调用一次）"""
    global _bm25_corpus, _bm25_model, _bm25_docs
    _bm25_docs = []

    for coll_name in SEARCH_COLLECTIONS:
        coll = chroma_client.get_or_create_collection(name=coll_name.strip())
        results = coll.get(include=["documents"])
        docs = results.get("documents", [])
        # extend = 把 docs 里每个元素逐个追加到 _bm25_docs（类似 JS 的 push(...arr)）
        _bm25_docs.extend(docs)

    if _bm25_docs:
        # 对每篇文档做 jieba 分词，构建 BM25 语料库
        _bm25_corpus = []
        for doc in _bm25_docs:
            tokens = list(jieba.cut(doc))
            _bm25_corpus.append(tokens)

        _bm25_model = BM25Okapi(_bm25_corpus)


def sparse_search(query: str, top_k: int = 10) -> list[tuple[str, float]]:
    """BM25 关键词检索"""
    if _bm25_model is None:
        _init_bm25()

    # 对查询分词
    query_tokens = list(jieba.cut(query))

    # 获取每个文档的 BM25 分数
    scores = _bm25_model.get_scores(query_tokens)

    # enumerate = 给每个分数打上序号（第几篇文档）
    indexed_scores = []
    for i, score in enumerate(scores):
        indexed_scores.append((i, score))

    # 按分数从高到低排序
    indexed_scores.sort(key=lambda pair: pair[1], reverse=True)

    # 取 top_k
    top_results = indexed_scores[:top_k]

    # 用索引找回原始文档内容
    result = []
    for i, score in top_results:
        result.append((_bm25_docs[i], score))
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

    # 所有分数都一样 → 没法归一化
    if min_s == max_s:
        if max_s > 0:
            # 分数都为正 → 全给 1.0
            return [1.0] * len(scores)
        else:
            # 分数全为 0 → 全给 0.0
            return [0.0] * len(scores)

    # 正常归一化：(原始值 - 最小值) / (最大值 - 最小值)
    result = []
    for s in scores:
        normalized = (s - min_s) / (max_s - min_s)
        result.append(normalized)
    return result


# ============================================================
# 混合检索：Dense + Sparse
# ============================================================

def hybrid_search(query: str, alpha: float = 0.7, top_k: int = 5) -> list[dict]:
    """
    混合检索：语义（Dense）+ 关键词（Sparse）加权融合
    alpha: Dense 的权重（0~1），默认 0.7 偏重语义
    """
    # 1. Dense 检索（语义匹配，多召回一些候选）
    dense_results = search_docs(query, top_k=20)

    # 2. Sparse 检索（关键词匹配）
    sparse_results = sparse_search(query, top_k=20)

    # 3. 对齐：把两路结果合并到一张表，缺失的补 0
    all_docs = {}
    for doc, score in dense_results:
        all_docs[doc] = {"dense": score, "sparse": 0.0}

    for doc, score in sparse_results:
        if doc in all_docs:
            all_docs[doc]["sparse"] = score
        else:
            all_docs[doc] = {"dense": 0.0, "sparse": score}

    # 4. 取出每个文档的 dense 分和 sparse 分
    docs_list = list(all_docs.keys())

    raw_dense_scores = []
    raw_sparse_scores = []
    for doc in docs_list:
        raw_dense_scores.append(all_docs[doc]["dense"])
        raw_sparse_scores.append(all_docs[doc]["sparse"])

    # 5. 归一化
    dense_scores = _normalize(raw_dense_scores)
    sparse_scores = _normalize(raw_sparse_scores)

    # 6. 线性加权：最终分 = α × 语义分 + (1-α) × 关键词分
    final_scores = []
    for i in range(len(docs_list)):
        combined = alpha * dense_scores[i] + (1 - alpha) * sparse_scores[i]
        if sparse_scores[i] == 0:
            # 关键词不匹配，适当降低 dense 权重，但不要一刀切
            combined = dense_scores[i] * 0.5  # # 保留一半
        # combined = alpha * dense_scores[i] + (1 - alpha) * sparse_scores[i]
        final_scores.append(combined)

    # 7. 配对 → 排序 → 取 top_k
    doc_score_pairs = list(zip(docs_list, final_scores))
    doc_score_pairs.sort(key=lambda pair: pair[1], reverse=True)
    top_results = doc_score_pairs[:top_k]

    # 8. 组装返回结果
    result = []
    for doc, score in top_results:
        result.append({"doc": doc, "score": round(score, 4)})

    for i, doc in enumerate(result):
     print(f"[HYBRID] dense={dense_scores[i]:.4f} sparse={sparse_scores[i]:.4f} "
          f"final={final_scores[i]:.4f} doc={doc['doc'][:50]}...")

    return result

def get_rank(results: list[tuple[str, float]]):
    rank_dict = {}
    for  rank, pair in enumerate(results, start=1):
        doc = pair[0]
        rank_dict[doc] = rank

    return rank_dict

def hybrid_search_rrf(query: str, top_k: int = 5, k: int = 60) -> list[dict]:
    """
    混合检索：使用 RRF（倒数排名融合）合并 Dense 和 Sparse 结果。
    k: 平滑因子，防止排名第1的文档得分过高，默认60。
    """
    # 1. Dense 检索（语义匹配，多召回一些候选）
    dense_results = search_docs(query, top_k=20)

    # 2. Sparse 检索（关键词匹配）
    sparse_results = sparse_search(query, top_k=20)

    # 3. 分别排序，计算排名（从1开始）
    # Dense 已经按分数降序返回，直接给排名
    dense_rank = get_rank(dense_results)

    sparse_rank = get_rank(sparse_results)

    # 4. 收集所有出现过的文档
    all_docs = set(dense_rank.keys()) | set(sparse_rank.keys())

    # 5. 为缺失的排名分配一个大数（表示排名靠后，贡献极小）
    # 通常取 max(len(dense), len(sparse)) + 1 或者一个固定大数如 1000
    MISSING_RANK = max(len(dense_rank), len(sparse_rank)) + 1

    rrf_scores = {}
    # 5. 计算 RRF 分数
    for doc in all_docs:
        r1 = dense_rank.get(doc, MISSING_RANK)
        r2 = sparse_rank.get(doc, MISSING_RANK)
        d_score = 1.0 / (k + r1)      # Dense 路贡献
        s_score = 1.0 / (k + r2)      # Sparse 路贡献
        rrf_scores[doc] = d_score + s_score

    # 6. 按 RRF 分数降序，返回 top_k
    sorted_docs = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)[:top_k]

    for doc, score in sorted_docs:
     print(f"[RRF] final={score:.4f} doc={doc[:50]}...")   # ✅ doc 就是文档内容

    return [{"doc": doc, "score": round(score, 6)} for doc, score in sorted_docs]


