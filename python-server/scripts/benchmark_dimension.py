"""
bge-m3 维度对比实验

运行：python scripts/benchmark_dimension.py
"""
import sys, os, time, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.services.rag import chroma_client, get_embedding


def load_embeddings():
    coll = chroma_client.get_collection(name="rag_medical")
    total = coll.count()
    all_embs = []
    for offset in range(0, total, 500):
        data = coll.get(include=["embeddings"], limit=500, offset=offset)
        embs = data["embeddings"]
        if embs is None or len(embs) == 0:
            break
        all_embs.extend(embs)
    return np.array(all_embs)


def brute_search(query_emb, doc_embs, top_k=10):
    t = time.perf_counter()
    sims = np.dot(doc_embs, query_emb)
    top = np.argsort(sims)[::-1][:top_k]
    ms = (time.perf_counter() - t) * 1000
    return set(int(i) for i in top), ms


def main():
    # 1. 加载全量 1024 维 embedding
    print("📂 加载 1024 维全量 embedding...")
    full_embs = load_embeddings()
    total, full_dim = full_embs.shape
    print(f"   共 {total} 条, 维度={full_dim}\n")

    # 2. 准备测试 query
    with open(os.path.join(os.path.dirname(__file__), "test_questions.json")) as f:
        test_cases = json.load(f)

    test_queries = [c["question"] for c in test_cases[:10]]  # 取 10 题
    print(f"测试查询: {len(test_queries)} 题\n")

    # 3. 不同维度对比
    dims = [1024, 512, 256, 128, 64]
    print(f"{'维度':>6s} {'搜索耗时':>10s} {'缩维耗时':>10s} {'内存占用':>10s} {'TOP-10一致':>10s}")
    print("-" * 55)

    baseline_top_sets = {}  # {query_idx: set(doc_indices)}  1024 维的基准结果

    for dim in dims:
        total_search = 0
        total_reduce = 0

        # 缩维：截断到前 dim 列（最简单的 PCA 替代方案，零计算开销）
        t = time.perf_counter()
        reduced_embs = full_embs[:, :dim]  # (N, dim)
        total_reduce = (time.perf_counter() - t) * 1000

        overlap_count = 0
        for qi, q_text in enumerate(test_queries):
            # query embedding 也缩到 dim 维
            full_q = np.array(get_embedding(q_text))
            q_emb = full_q[:dim]

            top_set, ms = brute_search(q_emb, reduced_embs, top_k=10)
            total_search += ms

            if dim == 1024:
                baseline_top_sets[qi] = top_set  # 保存基准
            else:
                overlap = len(top_set & baseline_top_sets[qi])
                overlap_count += overlap

        avg_search = total_search / len(test_queries)
        mem_mb = reduced_embs.nbytes / (1024 * 1024)

        if dim == 1024:
            overlap_str = "基准"
        else:
            avg_overlap = overlap_count / len(test_queries)
            overlap_str = f"{avg_overlap:.1f}/10"

        print(f"{dim:>4}d  {avg_search:>8.1f}ms {total_reduce:>8.1f}ms {mem_mb:>8.1f}MB {overlap_str:>10s}")

    print(f"\n💡 结论：")
    print(f"   维度越高 → 精度越好，但内存和计算成本越大")
    print(f"   找到精度损失 <5% 的最小维度，就是性价比最优解")


if __name__ == "__main__":
    main()
