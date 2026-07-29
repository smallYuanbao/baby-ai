
from app.services.rag.retriever import hybrid_search
from services.pipeline.rewrite import rewrite_query


def test_hybrid_search_returns_results():
    """测试混合检索能返回结果"""
    results = hybrid_search("宝宝发烧怎么办", top_k=3)
    assert len(results) > 0
    assert "doc" in results[0]
    assert "score" in results[0]

def test_query_rewrite_detects_pronoun():
    """测试 Query Rewrite 能检测代词"""
    history = [
        {"role": "user", "content": "宝宝发烧怎么办"},
        {"role": "assistant", "content": "建议物理降温..."}
    ]

    result = rewrite_query("他需要吃药吗", history)

    assert result.wasRewritten
    # 改写后的查询应该包含"宝宝"
    assert "宝宝" in result.rewritten_query