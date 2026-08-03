"""
ANN vs 暴力搜索 性能对比

## 背景：两套搜索系统各司其职

  - bge-m3（模型）   ：只负责把文本变成向量。比如 "宝宝发烧" → [0.12, -0.34, 0.56, ...]
                      这个向量有 1024 个数字（1024 维）。至于怎么搜，模型不管。

  - ChromaDB（数据库）：拿到 bge-m3 产出的 1024 维向量后，建 HNSW 图索引做 ANN 近似搜索。
                      ANN = Approximate Nearest Neighbor，不扫全库，在图里跳几跳就找到近似结果。

## 两种搜索方式

  ### ANN 搜索（近似最近邻）
  ChromaDB 默认用 HNSW（Hierarchical Navigable Small World）图索引。
  原理：预先给所有文档向量建一张"小世界图"，相似文档靠得近。搜索时在图里跳几跳，
  不用扫全库，O(log N) 就能找到近似 top-k。快但不保证全局最优。

  ### 暴力搜索（精确最近邻）
  不做任何索引，不建图，不近似。query 向量和库里每一篇文档都算一次点积，
  算出 N 个分数后排序取 top-k，O(N)，100% 精确。

## 点积（Dot Product）是什么

  点积 = 两个向量逐位相乘，再全部加起来。一个数。

  例（简化到 4 维）：
    query =  [0.8, 0.1, 0.3, 0.5]
    doc   =  [0.7, 0.2, 0.4, 0.6]

    点积 = 0.8×0.7 + 0.1×0.2 + 0.3×0.4 + 0.5×0.6
         = 0.56  + 0.02  + 0.12  + 0.30
         = 1.00   ← 相关的文档分数高

  为什么点积可以替代余弦相似度？
    bge-m3 产出的向量已经 L2 归一化了（向量长度 ≈ 1.0）。
    归一化后 点积 = 余弦相似度，省去除法步骤。

## 暴力搜索的计算过程（3633 条数据为例）

  不是把 3633 篇文档"塞进一个向量里"，而是把它们摞成一张大表：

    文档0  → [0.1, -0.3,  0.7, ...,  0.2]  ← 第 0 行，1024 个数
    文档1  → [0.5,  0.2, -0.1, ...,  0.8]  ← 第 1 行，1024 个数
    文档2  → [-0.4, 0.9,  0.3, ..., -0.1]  ← 第 2 行，1024 个数
    ...
    文档3632→[0.3, -0.2,  0.6, ...,  0.1]  ← 第 3632 行，1024 个数

    query  → [0.8, 0.1, 0.3, ..., 0.5]       ← 1 行，1024 个数

  np.dot(大表, query) 一次矩阵乘法，等于把 query 和每一行各做一次点积：

    文档0   点积 → 0.92
    文档1   点积 → 0.45
    文档2   点积 → 1.03
    ...
    文档3632 点积 → 0.18

  3633 行 → 3633 个分数。最后 np.argsort 排序，取前 10 个 = 暴力搜索完成。

  NumPy 的 dot() 底层是 C/Fortran 写的 BLAS，几千条数据一毫秒算完。

## 什么时候 ANN 比暴力快？

  | 数据量     | 谁更快    | 原因                                    |
  |-----------|----------|-----------------------------------------|
  | < 1 万条  | 暴力更快  | BLAS 矩阵乘法 O(N) 很小，ANN 建图反而有开销 |
  | 1万~10万  | 差不多    | 临界区                                   |
  | > 10 万   | ANN 碾压  | 全量扫 O(N) 太慢了，必须用索引 O(log N)     |

运行：python scripts/benchmark_search.py
"""

import sys
import os
import time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.rag.embedding import chroma_client, get_embedding
from app.core.config import SEARCH_COLLECTIONS


def load_all_embeddings():
    """
    从 rag_medical 分页加载所有文档的 embedding 向量。

    ChromaDB 的 get() 一次最多返回若干条，超过需要分页。
    Returns:
        embeddings: (N, 1024) 的 numpy 二维数组
        ids:       长度为 N 的文档 ID 列表
    """
    coll = chroma_client.get_collection(name="rag_medical")
    total = coll.count()
    batch_size = 500  # 每次取 500 条，防止单次请求太大

    all_embs = []
    all_ids = []
    for offset in range(0, total, batch_size):
        data = coll.get(include=["embeddings"], limit=batch_size, offset=offset)
        embs = data["embeddings"]
        ids = data["ids"]
        if embs is None or len(embs) == 0:
            break
        all_embs.extend(embs)
        all_ids.extend(ids)

    embeddings = np.array(all_embs)  # (N, 1024)
    return embeddings, all_ids


def ann_search(query_embedding, top_k=10):
    """
    ANN 搜索（Approximate Nearest Neighbor，近似最近邻）。

    ChromaDB 默认使用 HNSW（Hierarchical Navigable Small World）图索引。
    原理：预先给所有文档向量建一张"分层小世界图"——
      相似文档在图里靠得近，搜的时候在图里跳几跳就能找到近似结果，
      不需要和库里的每一篇文档都算一遍。

    和暴力搜索的区别：
      - 暴力：query 和 3633 篇逐一算点积 → 100% 精确
      - ANN：  query 在图里导航跳几跳       → 近似结果，但快得多（大数据量时）
    """
    coll = chroma_client.get_collection(name="rag_medical")
    t_start = time.perf_counter()
    result = coll.query(query_embeddings=[query_embedding.tolist()], n_results=top_k)
    elapsed_ms = (time.perf_counter() - t_start) * 1000
    return result["ids"][0], elapsed_ms


def brute_force_search(query_embedding, embeddings_np, all_ids, top_k=10):
    """
    暴力搜索（精确最近邻）：query 和库里的每一篇文档都算一次点积。

    ===== 计算过程（以当前 3633 条数据为例）=====

    embeddings_np 是 (3633, 1024) 的大表，query_embedding 是 (1024,) 的向量。

    ① np.dot(embeddings_np, query_embedding)
       = 一次矩阵乘法 = 把 query 和每一行各做一次点积
       输出: (3633,) 的一维数组，每个元素是一篇文档的分数
       例: [0.92, 0.45, 1.03, ..., 0.18]
            文档0  文档1  文档2      文档3632

    ② np.argsort(similarities)  = 按分数从小到大排序，返回原始位置（索引）
       例: 分数 [0.92, 0.45, 1.03] → argsort 返回 [1, 0, 2]
           （最小的在索引1，中间的在索引0，最大的在索引2）

    ③ [::-1] 反转顺序 = 从大到小
       → [2, 1, 0]（分数最高在索引2）

    ④ [:top_k] 取前10个

    ⑤ 用索引取回对应的文档 ID

    ===== 为什么用点积而不用余弦相似度？=====

      - bge-m3 生成的向量已经 L2 归一化（向量长度 ≈ 1.0）
      - 归一化后 点积 = 余弦相似度，省去除法步骤
      - NumPy 的 dot() 底层是 C/Fortran 写的 BLAS 矩阵乘法
        3633 条数据 < 2ms 算完

    ===== 和 ANN 的核心区别 =====

      ANN (HNSW):   query → 图导航跳几跳 → 近似 top10        O(log N)
                    数据量大时快很多，但不保证全局最优
      暴力 (Brute):  query → 和 N 个文档一一算 → 精确 top10    O(N)
                    100% 精确，数据量越大越慢
    """
    # 第1步：全量点积 → 每篇文档一个分数
    t_start = time.perf_counter()
    similarities = np.dot(embeddings_np, query_embedding)     # (3633,) 一维数组

    # 第2步：按分数降序排列，取 top_k 的索引
    top_indices = np.argsort(similarities)[::-1][:top_k]

    elapsed_ms = (time.perf_counter() - t_start) * 1000

    # 第3步：用索引取回文档 ID
    result_ids = [all_ids[i] for i in top_indices]
    return result_ids, elapsed_ms


def main():
    # ---- 1. 加载全部 embedding ----
    print("📂 加载向量库...")
    embeddings_np, all_ids = load_all_embeddings()
    total = len(all_ids)
    dim = embeddings_np.shape[1]
    print(f"   共 {total} 条, 维度={dim}\n")

    # ---- 2. 准备测试查询 ----
    test_queries = [
        "宝宝发烧38.5度需要吃退烧药吗",
        "宝宝不爱吃辅食怎么办",
        "宝宝晚上老是醒",
        "宝宝打疫苗后要注意什么",
        "宝宝洗澡水温多少合适",
    ]

    # ---- 3. 逐条对比 ----
    print(f"{'查询':<30s} {'ANN':>8s} {'暴力':>8s} {'一致':>6s} {'速度比':>6s}")
    print("-" * 65)

    ann_times = []
    brute_times = []
    overlaps = []

    for query_text in test_queries:
        # 生成 query embedding（这个不计入搜索耗时）
        q_emb = np.array(get_embedding(query_text))

        # ANN 搜索
        ann_ids, ann_ms = ann_search(q_emb, top_k=10)

        # 暴力搜索
        brute_ids, brute_ms = brute_force_search(q_emb, embeddings_np, all_ids, top_k=10)

        # 结果一致性
        overlap = len(set(ann_ids) & set(brute_ids))

        ann_times.append(ann_ms)
        brute_times.append(brute_ms)
        overlaps.append(overlap)

        ratio = brute_ms / ann_ms if ann_ms > 0 else 0
        marker = "✅" if overlap == 10 else f"⚠️"
        print(f"{query_text:<30s} {ann_ms:>6.1f}ms {brute_ms:>6.1f}ms {overlap:>4d}/10 {ratio:>5.1f}x {marker}")

    # ---- 4. 汇总 ----
    avg_ann = sum(ann_times) / len(ann_times)
    avg_brute = sum(brute_times) / len(brute_times)
    avg_overlap = sum(overlaps) / len(overlaps)

    print(f"\n{'='*65}")
    print(f"📊 汇总 ({total} 条文档, {dim} 维)")
    print(f"   ANN 平均耗时:        {avg_ann:.1f} ms")
    print(f"   暴力搜索平均耗时:    {avg_brute:.1f} ms")
    print(f"   平均结果一致性:      {avg_overlap:.1f} / 10")
    print(f"   速度比:              暴力 {'快' if avg_brute < avg_ann else '慢'} {avg_ann/avg_brute:.1f}x")

    if avg_brute < avg_ann:
        print(f"\n💡 当前 {total} 条数据量下，暴力搜索比 ANN 更快。")
        print(f"   当数据量超过 ~5 万条时，ANN 的优势会开始显现。")
    else:
        print(f"\n💡 ANN 搜索更快，说明数据量已超过暴力搜索的临界点。")


if __name__ == "__main__":
    main()
