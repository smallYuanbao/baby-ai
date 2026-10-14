
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

# —— 缓存准入:只有「真的答出来了」才进缓存 ——

def test_cacheable_rejects_empty_and_fallback():
    """空回答和降级兜底都不该进缓存 —— 否则一次偶发失败会被永久缓存给那个问题。

    实测踩过:3/16 条空回答 + 2/9 条「服务繁忙」兜底文案,且服务不重启不会自愈。
    """
    from app.services.chat_service import _is_cacheable
    from app.services.llm import FALLBACK_TEXT

    assert _is_cacheable("宝宝发烧可以物理降温") is True
    assert _is_cacheable("") is False
    assert _is_cacheable("   ") is False
    assert _is_cacheable(None) is False
    assert _is_cacheable(FALLBACK_TEXT) is False   # 非空,但光判空拦不住
