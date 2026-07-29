
from app.services.rag.retriever import hybrid_search
from app.services.pipeline.rewrite import rewrite_query


def test_hybrid_search_returns_results():
    """测试混合检索能返回结果"""
    results = hybrid_search("宝宝发烧怎么办", top_k=3)
    assert len(results) > 0
    assert results[0].text        # RAGDocument 是 Pydantic 模型，用 .属性 访问
    assert results[0].score is not None

def test_query_rewrite_detects_pronoun():
    """测试 Query Rewrite 能检测代词"""
    from app.models.chat import ChatHistoryEntry
    history = [
        ChatHistoryEntry(role="user", content="宝宝发烧怎么办"),
        ChatHistoryEntry(role="assistant", content="建议物理降温..."),
    ]

    result = rewrite_query("他需要吃药吗", history)

    assert result.wasRewritten
    assert "宝宝" in result.rewrittenQuery