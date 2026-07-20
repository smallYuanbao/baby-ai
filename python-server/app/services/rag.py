import chromadb
from chromadb.config import Settings
from app.core.config import CHROMA_HOST, CHROMA_PORT, SEARCH_COLLECTIONS, OLLAMA_BASE_URL, OLLAMA_PORT, OLLAMA_MODEL

import jieba
from rank_bm25 import BM25Okapi

from app.models.chat import RAGDocument

# 初始化 chroma client（连接 Docker ChromaDB）
chroma_client = chromadb.HttpClient(
    host=CHROMA_HOST,
    port=CHROMA_PORT,
    settings=Settings(anonymized_telemetry=False),
)


def get_embedding(text: str) -> list[float]:
    """调用 Ollama 的 bge-m3 模型生成向量"""
    import requests

    # 兼容两种配置：纯 host（127.0.0.1）和完整 URL（http://127.0.0.1:11434）
    base = OLLAMA_BASE_URL
    if not base.startswith("http"):
        base = f"http://{base}:{OLLAMA_PORT}"

    response = requests.post(
        f"{base}/api/embed",
        json={"model": OLLAMA_MODEL, "input": [text]},
    )
    response.raise_for_status()
    return response.json()["embeddings"][0]


def search_docs(query: str, top_k: int = 3) -> list[RAGDocument]:
    """多 collection 向量检索 + 合并排序，返回 [(文档内容, 距离), ...]"""
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

    # 按距离升序（距离越小越相关）
    all_docs.sort(key=lambda d: d.distance)

    return all_docs[:top_k]


# ============================================================
# BM25 稀疏检索（关键词匹配）
# ============================================================

_bm25_corpus = None
_bm25_model = None
_bm25_docs = []     # 以前只存 text
_bm25_ids = []      # 新增：存 id
_bm25_metadata = [] # 新增：存 metadata


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
        # 对每篇文档做 jieba 分词，构建 BM25 语料库
        _bm25_corpus = []
        for doc in _bm25_docs:
            tokens = list(jieba.cut(doc))
            _bm25_corpus.append(tokens)

        _bm25_model = BM25Okapi(_bm25_corpus)


def sparse_search(query: str, top_k: int = 10) -> list[RAGDocument]:
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


# ============================================================
# 方式一：线性加权融合 (hybrid_search)
# ============================================================
#
# 思路：
#   1. 分别跑 Dense（向量语义）和 Sparse（BM25 关键词）两路检索
#   2. 把两路结果合并到一张表，只在单路出现的文档另一路分数补 0
#   3. 归一化：把 Dense 和 Sparse 的分数都压到 0~1 区间
#      - 为什么必须归一化？Dense 分可能是 0.8-0.9，BM25 分可能是 2-10，
#        尺度不同，不归一化没法加在一起
#   4. 线性加权：final = α × Dense归一化分 + (1-α) × Sparse归一化分
#      - α=0.7 更偏语义，α=0.3 更偏关键词
#   5. 按 final 从高到低排序，取 top_k
#
# 优点：简单直觉，调 α 就能控制偏向
# 缺点：需要归一化，尺度差异大时归一化可能不稳定

def hybrid_search(query: str, alpha: float = 0.7, top_k: int = 5) -> list[RAGDocument]:
    """
    混合检索（线性加权版）：语义（Dense）+ 关键词（Sparse）加权融合

    alpha: Dense 权重（0~1），默认 0.7 = 更偏语义匹配
    """
    # ============================================================
    # Step 1：Dense 检索 — 向量语义匹配
    # ============================================================
    # 多召回一些候选文档（20 条 > 最终需要的 5 条），给后面的融合留足够选择空间
    dense_results = search_docs(query, top_k=20)

    # ============================================================
    # Step 2：Sparse 检索 — BM25 关键词匹配
    # ============================================================
    sparse_results = sparse_search(query, top_k=20)

    text_to_id = {}
    for d in dense_results:
        if d.id:  # 只记录有实际 id 的
            text_to_id[d.text] = d.id
    for d in sparse_results:
        if d.id and d.text not in text_to_id:
            text_to_id[d.text] = d.id

    # ============================================================
    # Step 3：对齐 — 把两路结果合并到一张表
    # ============================================================
    # all_docs 的结构：
    #   { "文档文本": {"dense": 0.88, "sparse": 2.3}, ... }
    #
    # 只在 Dense 路出现的 → sparse 补 0.0
    # 只在 Sparse 路出现的 → dense 补 0.0
    # 两路都出现的    → 各自存各自的分

    all_docs: dict[str, dict] = {}

    # 3a：先遍历 Dense 结果，写入 dense 分，sparse 暂填 0
    for d in dense_results:
        # distance（距离）越小越相关，用 1 - distance 转成"越大越相关"的分数
        similarity = 1.0 - (d.distance or 0)
        all_docs[d.text] = {"dense": similarity, "sparse": 0.0}

    # 3b：再遍历 Sparse 结果，更新 sparse 分
    for d in sparse_results:
        if d.text in all_docs:
            # 这个文档 Dense 路也命中了 → 只更新 sparse 分
            all_docs[d.text]["sparse"] = d.score or 0.0
        else:
            # 这个文档只有 Sparse 路命中 → 新建一条，dense 补 0
            all_docs[d.text] = {"dense": 0.0, "sparse": d.score or 0.0}

    # ============================================================
    # Step 4：把两路分数分别取出来，准备归一化
    # ============================================================
    doc_texts = list(all_docs.keys())  # 所有候选文档的文本列表

    # 用 for 循环从字典中依次取出每个文档的 dense 分和 sparse 分
    raw_dense_scores = []
    raw_sparse_scores = []
    for doc_text in doc_texts:
        raw_dense_scores.append(all_docs[doc_text]["dense"])
        raw_sparse_scores.append(all_docs[doc_text]["sparse"])

    # ============================================================
    # Step 5：归一化 — 把两路分都压到 0~1
    # ============================================================
    # 为什么必须做？
    #   归一化前：dense分 ∈ [0.7, 0.95]，sparse分 ∈ [0, 15]
    #   直接加权：0.7×0.85 + 0.3×12 = 根本没法比
    #   归一化后：都在 [0, 1]，公平竞争
    dense_scores = _normalize(raw_dense_scores)
    sparse_scores = _normalize(raw_sparse_scores)

    # ============================================================
    # Step 6：线性加权 — final = α × 语义 + (1-α) × 关键词
    # ============================================================
    final_scores = []
    for i in range(len(doc_texts)):
        combined = alpha * dense_scores[i] + (1 - alpha) * sparse_scores[i]

        # 特殊处理：关键词完全不命中 → 适当降权
        # 因为"只有语义命中、关键词完全没命中"的文档可能是碰巧相似
        if sparse_scores[i] == 0:
            # dense分 × 0.5：保留一半权重，不至于被埋没
            combined = dense_scores[i] * 0.5

        final_scores.append(combined)

    # ============================================================
    # Step 7：把文档和分数配对 → 按分数从高到低排序
    # ============================================================
    # zip("拉链"合并) — 把两个列表按位置一一对应
    #   doc_texts  = ["文档A", "文档B", "文档C"]
    #   final_scores = [0.779,   0.300,   0.385]
    #   → [("文档A", 0.779), ("文档B", 0.300), ("文档C", 0.385)]
    doc_score_pairs = list(zip(doc_texts, final_scores))

    # pair[1] = 元组的第二个元素 = 分数，reverse=True 从高到低排
    doc_score_pairs.sort(key=lambda pair: pair[1], reverse=True)

    # ============================================================
    # Step 8：取前 top_k 个，组装返回结果
    # ============================================================
    result = []
    for doc_text, score in doc_score_pairs[:top_k]:
        doc_id = text_to_id.get(doc_text, "")    # 查不到就是空字符串
        result.append(RAGDocument(id=doc_id, text=doc_text, score=round(score, 4)))

    return result


# ============================================================
# 方式二：RRF 排名融合 (hybrid_search_rrf)
# ============================================================
#
# RRF = Reciprocal Rank Fusion（倒数排名融合）
#
# 思路（和线性加权的核心区别）：
#   - 线性加权：用"分数"做融合，需要归一化
#   - RRF：      用"排名"做融合，不需要归一化
#
# 公式：RRF_score(文档) = 1/(k + Dense路排名) + 1/(k + Sparse路排名)
#
# 举例：
#   文档A：Dense路排第1名，Sparse路排第3名，k=60
#   → RRF = 1/(60+1) + 1/(60+3) = 0.0164 + 0.0159 = 0.0323
#
#   文档B：Dense路排第2名，Sparse路排第1名
#   → RRF = 1/(60+2) + 1/(60+1) = 0.0161 + 0.0164 = 0.0325  ← B 比 A 高！
#
# 为什么用 k=60？
#   平滑因子，防止排名第1的文档得分过高（没有 k 的话 1/1 = 1.0，太极端了）
#
# 优点：不需要归一化，天然处理单路命中，实现更简单
# 缺点：排名信息比分数信息粗糙（第1名和第2名可能实际分数非常接近）


def get_rank(results: list[RAGDocument]) -> dict[str, int]:
    """
    给检索结果打排名（第1名 = 1，第2名 = 2，...）

    输入：[RAGDocument("文档A", 0.95), RAGDocument("文档B", 0.88), ...]
    输出：{"文档A": 1, "文档B": 2, ...}

    enumerate(..., start=1) 让编号从 1 开始（不写 start 默认从 0 开始）
    """
    rank_dict = {}
    for rank, d in enumerate(results, start=1):
        rank_dict[d.text] = rank
    return rank_dict


def hybrid_search_rrf(query: str, top_k: int = 5, k: int = 60) -> list[RAGDocument]:
    """
    混合检索（RRF 版）：用排名融合替代分数加权，不需要归一化

    k: 平滑因子，默认 60（业界经验值，越大排名差异越小）
    """
    # ============================================================
    # Step 1 + 2：两路各自检索
    # ============================================================
    dense_results = search_docs(query, top_k=20)


    sparse_results = sparse_search(query, top_k=20)

    text_to_id = {}
    for d in dense_results:
        if d.id:  # 只记录有实际 id 的
            text_to_id[d.text] = d.id
    for d in sparse_results:
        if d.id and d.text not in text_to_id:
            text_to_id[d.text] = d.id

    # ============================================================
    # Step 3：给两路结果各自打排名
    # ============================================================
    # dense_rank  = {"文档A": 1, "文档B": 2, "文档C": 3, ...}
    # sparse_rank = {"文档B": 1, "文档D": 2, "文档A": 3, ...}
    dense_rank = get_rank(dense_results)
    sparse_rank = get_rank(sparse_results)

    # ============================================================
    # Step 4：收集所有出现过的文档（两路去重合并）
    # ============================================================
    # set 自动去重，| 是取并集（两边合并，重复的只留一个）
    all_texts = set(dense_rank.keys()) | set(sparse_rank.keys())

    # ============================================================
    # Step 5：缺失排名处理
    # ============================================================
    # 有些文档只在一路出现，另一路没有排名。
    # 给缺失的排名一个"大数"（比如两路都各 20 个文档，缺失的排名 = 21）
    # 这样缺失的那一路贡献会很小（1/(60+21) ≈ 0.012），而不会得 0 分
    MISSING_RANK = max(len(dense_rank), len(sparse_rank)) + 1

    # ============================================================
    # Step 6：对每个文档计算 RRF 分数
    # ============================================================
    # RRF 公式：1/(k + rank_in_dense) + 1/(k + rank_in_sparse)
    #
    # 文档A：Dense排1，Sparse排3  → 1/(60+1) + 1/(60+3) = 0.0164 + 0.0159 = 0.0323
    # 文档B：Dense排2，Sparse排1  → 1/(60+2) + 1/(60+1) = 0.0161 + 0.0164 = 0.0325
    # 文档D：只有Sparse排2        → 1/(60+21)+ 1/(60+2) = 0.0123 + 0.0161 = 0.0285
    rrf_scores = {}
    for text in all_texts:
        # 获取该文档在 Dense 路的排名，没命中就用 MISSING_RANK
        rank_in_dense = dense_rank.get(text, MISSING_RANK)
        dense_contribution = 1.0 / (k + rank_in_dense)

        # 获取该文档在 Sparse 路的排名
        rank_in_sparse = sparse_rank.get(text, MISSING_RANK)
        sparse_contribution = 1.0 / (k + rank_in_sparse)

        # 两路贡献相加 = RRF 总分
        rrf_scores[text] = dense_contribution + sparse_contribution

    # ============================================================
    # Step 7：按 RRF 总分从高到低排序 → 取 top_k
    # ============================================================
    # rrf_scores.items() 返回 [("文档A", 0.0323), ("文档B", 0.0325), ...]
    # sorted(..., key=lambda pair: pair[1], reverse=True)
    #   → pair[1] = 元组第二个元素 = RRF分数，从高到低排
    sorted_items = sorted(
        rrf_scores.items(),
        key=lambda pair: pair[1],
        reverse=True,
    )
    top_items = sorted_items[:top_k]

    # ============================================================
    # Step 8：组装返回结果
    # ============================================================

    result = []
    for text, score in top_items:
        doc_id = text_to_id.get(text, "")    # 查不到就是空字符串
        result.append(RAGDocument(id = doc_id, text=text, score=round(score, 6)))

    return result


# ============================================================
# 进阶参考：两种方式如何选择
# ============================================================
#
# | 场景 | 推荐方式 | 原因 |
# |------|---------|------|
# | 检索质量要求高 | RRF | 排名更稳健，不受分数尺度影响 |
# | 需要精确控制偏向 | 线性加权 | 可以调 α 控制语义 vs 关键词的侧重 |
# | 召回量少的场景 | RRF | 不需要归一化，少一个出错点 |
# | 快速原型 | 线性加权 | 直觉简单，容易调试 |
#
# 当前在 chat_service.py 中使用的是 hybrid_search_rrf，
# 如需切换回线性加权，把 hybrid_search_rrf 替换为 hybrid_search 即可。