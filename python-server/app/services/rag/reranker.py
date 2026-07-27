"""
RAG 精排服务 (Reranker)

## 在 RAG 管线中的位置

```
用户查询
  → 查询改写 (query_rewrite.py)
  → 向量召回 (rag.py 的 search_docs)      ← 粗排，按向量距离排序
  → 精排 (本文件)                          ← 对候选文档重新打分排序
  → 上下文拼装 (prompt.py 的 buildPrompt)
  → 调 LLM 生成回答
```

## 为什么需要精排？

向量检索（Dense）和 BM25（Sparse）都只是"粗排"：
  - Dense：比较的是 query 向量和 doc 向量的余弦距离，不如直接比较原文精准
  - BM25：只看关键词命中，不理解语义

精排做的是"把 query 和每个候选文档的原文一起读一遍"，打出真正的相关性分数。

## 三级降级策略

```
第一优先：BGE Reranker 专用模型
  └─ 不可用 → 第二优先：DeepSeek LLM 排序
       └─ 不可用 → 最终兜底：原始向量距离排序（保证不挂）
```
"""

from typing import Optional

from app.core.config import RERANKER_URL
from app.models.chat import ChatMessage, ChatOptions, RAGDocument
from app.services.llm import call_deepseek


# ============================================================
# 第一优先：BGE Reranker 专用模型（精度最高）
# ============================================================
#
# BGE Reranker 是什么？
#   一个专门做"精排"的深度学习模型（Cross-Encoder 架构）。
#   它把 (query, document) 当成一个句子对输入，直接输出相关性分数。
#
#   和向量检索的区别：
#     - 向量检索：query → embedding，doc → embedding，然后算余弦距离
#       → 两个 embedding 是独立生成的，query 和 doc 之间没有交互
#     - BGE Reranker：query + doc 一起送入模型，模型同时看两边
#       → query 和 doc 之间可以"互相对照"，精度更高
#
#   为什么不在召回阶段就直接用？
#     - 太慢了：Cross-Encoder 需要把每对 (query, doc) 都跑一遍
#       → 1000 篇文档 = 1000 次推理，受不了
#     - 所以先用向量检索（快）召回 20 条，再用 Reranker（准）精排这 20 条
#
# BGE Reranker API 格式：
#   请求:  POST /rerank
#         { "query": "...", "documents": [{"id":"x","text":"..."}], "top_k": 5 }
#   响应:  { "results": [{"id":"x","score":0.95}, ...] }
#          ↑ 只返回 id+score，不返回完整文档，需要自己映射回去

def rerank_with_bge(query: str, docs: list[RAGDocument], top_k: int):
    """
    调用 BGE Reranker 服务进行 Cross-Encoder 精排。

    返回值：
      成功 → 按 score 降序的文档列表（每篇文档新增 score 字段）
      失败 → None（由调用方降级到下一级方案）
    """
    import requests

    # 如果 RERANKER_URL 未配置，直接返回 None，跳过这一级
    if not RERANKER_URL:
        return None

    try:
        # ============================================================
        # Step 1：发送请求到 BGE Reranker 服务
        # ============================================================
        # json= 参数会自动设置 Content-Type: application/json
        # 只发送 id 和 text，distance 是向量阶段的产物，对 Cross-Encoder 无意义
        # timeout=120：首次推理可能涉及模型加载，给足时间
        response = requests.post(
            url=RERANKER_URL,
            json={
                "query": query,
                "documents": [{"id": d.id, "text": d.text} for d in docs],
                "top_k": top_k,
            },
            timeout=120,
        )

        # ============================================================
        # Step 2：检查 HTTP 状态码
        # ============================================================
        # raise_for_status()：如果状态码是 4xx 或 5xx → 抛出 HTTPError
        response.raise_for_status()

        # ============================================================
        # Step 3：解析响应
        # ============================================================
        # .json() 把 JSON 字符串转成 Python 字典
        # 响应格式：{"results": [{"id": "doc_01", "score": 0.95}, ...]}
        data = response.json()

        # ============================================================
        # Step 4：把分数映射回原始文档
        # ============================================================
        # Reranker 只返回 {id, score}，不返回文档内容
        # 所以需要拿 id 去原始 docs 里找到对应的完整文档，把 score 附加上去
        #
        # 先建一个 id → score 的映射表，方便 O(1) 查找
        #   例：{"doc_01": 0.95, "doc_02": 0.72, ...}
        score_map = {}
        for r in data["results"]:
            score_map[r["id"]] = r["score"]

        # ============================================================
        # Step 5：遍历原始文档，附加 score，只保留 Reranker 打了分的
        # ============================================================
        ranked = []
        for d in docs:
            doc_id = d.id                     # ← Pydantic 模型用 .属性 访问
            if doc_id in score_map:
                # .model_dump() 把 Pydantic 模型转成普通字典（Pydantic v2 方法）
                doc_copy = d.model_dump()
                doc_copy["score"] = score_map[doc_id]
                ranked.append(doc_copy)

        # ============================================================
        # Step 6：按 score 降序排列
        # ============================================================
        ranked.sort(key=lambda d: d["score"], reverse=True)

        return ranked

    except Exception as e:
        # ============================================================
        # 任何异常都返回 None，触发调用方降级
        # ============================================================
        # 可能的异常：
        #   - requests.exceptions.ConnectionError：服务没启动
        #   - requests.exceptions.Timeout：超时
        #   - requests.exceptions.HTTPError：HTTP 4xx/5xx
        #   - KeyError：响应格式不符合预期
        print(f"BGE Reranker 不可用 ({e})，回退到 DeepSeek 排序")
        return None


# ============================================================
# 第二优先：DeepSeek LLM 排序（兜底方案）
# ============================================================
#
# 当 BGE Reranker 不可用时（没部署/超时/报错），用 LLM 做排序。
#
# 思路：
#   1. 把候选文档列表编号后发给 DeepSeek
#   2. DeepSeek 返回它认为最相关的文档编号
#   3. 按 DeepSeek 返回的顺序重排文档
#
# 和 BGE Reranker 的区别：
#   - BGE：专门的精排模型，分数是真实的语义相关性
#   - DeepSeek：通用 LLM，分数是按排名位置"人造"的（第1名≈1.0，依次递减）
#
# Prompt 示例：
#   "从下列文档中选出与查询最相关的 5 条，每行输出一个编号（只输出数字）：
#    查询：宝宝发烧怎么办
#    [0] 宝宝发烧时，家长首先要保持冷静...
#    [1] 退烧药的使用方法...
#    ..."
#
# DeepSeek 返回：
#   1
#   0
#   3
#   ...

def rerank_with_llm(query: str, docs: list[RAGDocument], top_k: int):
    """
    用 DeepSeek LLM 对文档做语义相关性排序。

    原理：把候选文档列表发给 LLM，让它选出最相关的 top_k 个并排序。
    temperature=0 确保每次相同输入得到相同排序。
    """
    # ============================================================
    # Step 1：格式化文档列表
    # ============================================================
    # 把每篇文档的前 200 字编号后拼到一起
    # 只取前 200 字是为了控制 prompt 长度，避免超出 LLM 上下文窗口
    # 输出示例：
    #   [0] 宝宝发烧时，家长首先要保持冷静，观察宝宝的精神状态...
    #   [1] 退烧药的使用方法：对乙酰氨基酚适用于3月龄以上...
    #   [2] 物理降温的正确方法：用温水毛巾擦拭额头...
    doc_list_text = "\n\n".join(
        f"[{i}] {d.text[:200]}" for i, d in enumerate(docs)
    )

    # ============================================================
    # Step 2：构建 Prompt + 调用 DeepSeek
    # ============================================================
    # temperature=0：确保输出确定性（相同输入 → 相同排序）
    # maxTokens=50：只返回几个数字编号，不需要很多 token
    messages = [ChatMessage(
        role="user",
        content=f"从下列文档中选出与查询最相关的 {top_k} 条，每行输出一个编号（只输出数字）：\n\n查询：{query}\n\n{doc_list_text}",
    )]
    options = ChatOptions(temperature=0, maxTokens=50)
    content = call_deepseek(messages, options)

    # ============================================================
    # Step 3：解析 LLM 输出 — 从文本中提取数字编号
    # ============================================================
    # LLM 返回的是多行文本，每行应该是一个数字，但可能夹杂空格或说明文字
    # 例："1\n0\n3\n" 或 "我认为是：\n1\n0\n3"
    #
    # 处理步骤：
    #   a) strip() 去首尾空白
    #   b) split("\n") 按换行切分
    #   c) 逐行 trim → 尝试转整数 → 过滤无效值

    lines = content.strip().split("\n")

    indices = []
    for line in lines:
        line = line.strip()

        # 跳过空行
        if line == "":
            continue

        # 尝试转整数（int("abc") 会抛 ValueError，用 try/except 跳过）
        try:
            n = int(line)
        except ValueError:
            continue  # 不是数字的行直接跳过

        # 检查编号是否在有效范围内（0 到 文档总数-1）
        if 0 <= n < len(docs):
            indices.append(n)

    # 只取前 top_k 个编号（多了也不要）
    indices = indices[:top_k]

    # ============================================================
    # Step 4：容错 — LLM 输出的编号全无效时的兜底
    # ============================================================
    # LLM 有时候会返回"无法确定"之类的文字而不是数字
    # 此时 indices 为空，退回按原始向量距离排序
    if len(indices) == 0:
        result = []
        for i, d in enumerate(docs[:top_k]):
            doc_copy = d.model_dump()                      # Pydantic → dict
            doc_copy["score"] = 1 - (d.distance or 0)      # 距离转正向分数
            result.append(doc_copy)
        return result

    # ============================================================
    # Step 5：按 LLM 选择的顺序重排文档，并分配递减的分数
    # ============================================================
    # indices 的顺序就是 LLM 认为的相关性顺序
    # indices[0] 是"最相关"的文档编号
    #
    # rank 从 0 开始：
    #   第 1 名（rank=0）→ score = 1 - 0/5 = 1.000
    #   第 2 名（rank=1）→ score = 1 - 1/5 = 0.800
    #   第 5 名（rank=4）→ score = 1 - 4/5 = 0.200
    # 这是人造的相对分数，不像 BGE 的分数那样有真实语义含义
    result = []
    for rank, idx in enumerate(indices):
        doc_copy = docs[idx].model_dump()     # Pydantic → dict
        doc_copy["score"] = 1 - rank / top_k  # 按排名分配递减分数
        result.append(doc_copy)

    return result


# ============================================================
# 精排入口：三级降级编排
# ============================================================
#
# 决策流程：
#
#   ┌────────────────────┐
#   │ len(docs) ≤ top_k? │
#   └──────┬─────────────┘
#          │
#     ┌────┼────┐
#     │YES      │NO
#     ▼         ▼
#   直接返回  ┌─────────────────┐
#   (短路)    │ BGE Reranker    │ ← 第一优先
#             └────────┬────────┘
#                      │
#                 ┌────┼────┐
#                 │有结果   │返回 None
#                 ▼         ▼
#               直接返回  ┌─────────────────┐
#                        │ DeepSeek LLM    │ ← 第二优先
#                        └────────┬────────┘
#                                 │
#                            ┌────┼────┐
#                            │成功      │抛异常
#                            ▼         ▼
#                          直接返回  ┌─────────────────────┐
#                                   │ 按原始 distance 排序  │ ← 最终兜底
#                                   └─────────────────────┘
#
# 注意：BGE 和 LLM 都在函数内部做了 try/except，
# BGE 通过返回 None 表示降级，LLM 通过抛异常表示降级。

def rerank(query: str, docs: list[RAGDocument], top_k: int):
    """
    文档重排序入口 — 三级降级：BGE → DeepSeek → 原始距离排序

    Args:
        query:  用户查询文本（已经过查询改写）
        docs:   候选文档列表，每个文档需含 id、text、distance
        top_k:  最终保留多少条文档

    Returns:
        {"query": query, "rankedDocuments": [...]}
        其中每个文档都是 dict，已附加 score 字段（0~1）
    """
    # ============================================================
    # 短路优化：文档数 ≤ top_k 时，不需要精排
    # ============================================================
    # 只有 3 条文档却要 top_k=5 → 全保留，直接转 score
    if len(docs) <= top_k:
        result = []
        for d in docs:
            # d.model_dump() 把 Pydantic 模型转成 dict
            # {**dict, "score": ...} 再追加 score 字段
            result.append({**d.model_dump(), "score": 1 - (d.distance or 0)})
        return {"query": query, "rankedDocuments": result}

    # ============================================================
    # 第一级：BGE Reranker（精度最高）
    # ============================================================
    # 返回 None 表示不可用 → 继续降级
    ranked = rerank_with_bge(query, docs, top_k)

    # ============================================================
    # 第二级：DeepSeek LLM 排序
    # ============================================================
    if not ranked:
        try:
            print("---docs---", docs)
            ranked = rerank_with_llm(query, docs, top_k)
        except Exception as e:
            # ============================================================
            # 最终兜底：连 DeepSeek 也失败了 → 按原始向量距离排序
            # ============================================================
            # 这是最后的防线，确保无论发生什么都能返回结果
            print(f"DeepSeek 排序也失败: {e}，使用原始检索结果")

            # sorted() 返回一个新列表，不修改原列表
            # distance 越小文档越相关 → 升序排列
            docs_sorted = sorted(docs, key=lambda d: d.distance or 0)

            result = []
            for d in docs_sorted[:top_k]:
                # .model_dump() 转 dict + 追加 score
                result.append({**d.model_dump(), "score": 1 - (d.distance or 0)})

            ranked = result


    print("Deepseek rerank 长度：", len(ranked))
    # ============================================================
    # 兜底补齐：精排结果不足 top_k 时，用原始文档补足
    # ============================================================
    # DeepSeek 可能只返回 2-3 个相关编号，如果不够 top_k，
    # 从原始 docs 中取还没被选中的文档补齐（用 text 前80字去重，因为 id 可能为空）
    if ranked and len(ranked) < top_k:
        selected_texts = {d.get("text", "")[:80] for d in ranked}

        for d in docs:
            if len(ranked) >= top_k:
                break
            if d.text[:80] not in selected_texts:
                ranked.append({**d.model_dump(), "score": 1 - (d.distance or 0)})

    return {"query": query, "rankedDocuments": ranked}


# ============================================================
# 进阶参考
# ============================================================
#
# 启动预热 — Express 版有 prewarmReranker()，在服务启动时对 BGE Reranker
# 发一个空请求，触发模型首次加载。深度学习模型首次推理包含模型加载、
# CUDA 编译等冷启动开销（可能 10-60 秒），预热后首次用户请求不会等这么久。
#
# 如果后续部署了 BGE Reranker，建议添加：
#
# def prewarm_reranker():
#     """服务启动时预热 BGE Reranker，避免首个用户踩到冷启动"""
#     if not RERANKER_URL:
#         return
#     try:
#         requests.post(
#             url=RERANKER_URL,
#             json={"query": "预热", "documents": [{"id":"0","text":"预热请求"}], "top_k": 1},
#             timeout=60,
#         )
#         print("BGE Reranker 预热完成")
#     except Exception as e:
#         print(f"BGE Reranker 预热失败: {e}，将在首次请求时加载")
