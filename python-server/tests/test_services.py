
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

# —— 精排降级:分数不能凭空变成 1.0 ——

def test_fallback_score_prefers_retrieval_score():
    """降级打分要优先用检索阶段已经算好的 score。

    实测踩过:兜底只读 distance,而 hybrid_search 返回的文档**根本没有 distance**
    (`d.distance or 0` 兜成 0),于是每篇文档都得到 `1 - 0 = 1.0`。
    症状:精排一旦降级,前端「相关性」徽章对全部 5 条引用都显示 100%,
    比不显示分数还误导——用户会以为每条证据都一样可信。
    """
    from app.models.chat import RAGDocument
    from app.services.rag.reranker import _fallback_score

    # hybrid_search 的形状:有 score、无 distance
    assert _fallback_score(RAGDocument(id="a", text="x", score=0.42)) == 0.42
    # ChromaDB 直查的形状:有 distance、无 score —— 距离越小越相关
    assert round(_fallback_score(RAGDocument(id="b", text="y", distance=0.3)), 6) == 0.7

# —— 流式生成:不传 options 不能崩 ——

def test_streaming_llm_accepts_none_options(monkeypatch):
    """调用方不传 options 时,流式生成必须照常发出请求。

    实测踩过:函数里写了 `opts = options or ChatOptions()` 兜底,但构造请求时
    误用了原始参数 `options.maxTokens`。主聊天接口正是**不传** options 的,
    于是每次流式请求都在 `options.maxTokens` 上抛 AttributeError,
    被 except 吞掉后静默降级成「服务繁忙」兜底话术——回答永远是那句,
    但引用照常返回,所以从界面上看很像「模型抽风」而不是代码错。
    """
    import asyncio

    from app.services import llm

    captured = {}

    class FakeAsyncStream:
        """空流——只为验证请求构造成功。

        必须实现 `__aiter__`/`__anext__` 和**异步**的 `close()`：
        流式已经改用 AsyncOpenAI + `async for`，finally 里也是 `await stream.close()`。
        """

        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

        async def close(self):
            pass

    async def fake_create(**kwargs):
        captured.update(kwargs)
        return FakeAsyncStream()

    # 注意 patch 的是**异步**客户端。patch 错对象的话这个测试会真的打线上 API
    # （踩过：拿同步客户端的补丁去测异步路径，结果真发了一次请求、烧了 token）。
    monkeypatch.setattr(llm.async_deepseek_client.chat.completions, "create", fake_create)
    monkeypatch.setattr(llm.breaker, "allow_request", lambda: True)

    class FakeRequest:
        async def is_disconnected(self) -> bool:
            return False

    async def drain():
        return [
            chunk
            async for chunk in llm.generate_stream_with_interrupt_and_fallback(
                [llm.ChatMessage(role="user", content="宝宝发烧怎么办")],
                FakeRequest(),
                None,            # ← 主聊天接口就是这么调的
            )
        ]

    asyncio.run(drain())

    # 真的走到了底层调用,而不是被 except 吞掉
    assert captured["max_tokens"] == llm.DEFAULT_MAX_TOKENS
    assert captured["stream"] is True


def test_streaming_llm_skips_call_when_client_already_gone(monkeypatch):
    """客户端在开跑前就断了 → 连 LLM 都不该调。

    检索可能花掉几十秒,用户往往在这期间就点了「停止生成」。这时再发一次
    LLM 请求纯属浪费(而且用户等不到)。
    """
    import asyncio

    from app.services import llm

    called = {"create": False}

    async def fake_create(**kwargs):
        called["create"] = True
        raise AssertionError("客户端已断开,不该调用 LLM")

    monkeypatch.setattr(llm.async_deepseek_client.chat.completions, "create", fake_create)
    monkeypatch.setattr(llm.breaker, "allow_request", lambda: True)

    class GoneRequest:
        async def is_disconnected(self) -> bool:
            return True

    async def drain():
        return [
            chunk
            async for chunk in llm.generate_stream_with_interrupt_and_fallback(
                [llm.ChatMessage(role="user", content="宝宝发烧怎么办")],
                GoneRequest(),
            )
        ]

    assert asyncio.run(drain()) == []      # 一个 token 都不产出
    assert called["create"] is False


def test_get_rag_context_aborts_at_first_checkpoint():
    """客户端断开时,检索在第一个取消点就放弃,不再往下走。

    「停止生成」原先名不副实的根因:断开只在开始吐 token 时才被察觉,
    而检索(查询改写 / 意图复核 / 混合检索 / 精排,含数次 LLM 调用)早就白跑完了。
    """
    import pytest

    from app.services.chat_service import RetrievalAborted, get_rag_context

    calls = {"n": 0}

    def should_abort() -> bool:
        calls["n"] += 1
        return True

    with pytest.raises(RetrievalAborted):
        get_rag_context(
            "宝宝发烧怎么办",
            "sess-abort-test",
            [],                 # 空历史 → 走服务端 session 分支
            "alice",
            None,
            should_abort,
        )

    assert calls["n"] == 1      # 第一个取消点就停,没有继续往下做检索

# —— 辅助 LLM 调用的输出预算:推理模型的思维链会吃光它 ——

def test_aux_llm_token_budgets_exceed_measured_need():
    """意图分类 / 精排的 max_tokens 不能定小。

    当前模型是推理模型,思维链和正文**共用** max_tokens。预算不够时思维链先把额度
    烧完,finish_reason=length,content 是空串,而且两侧都是**静默降级**:
    意图分类退化成 general、LLM 精排退化成按向量距离排序——表面上只有一句
    「LLM 上游返回空内容」,很难定位到是自己的预算定小了。

    实测(deepseek-v4-flash):
      · 意图分类:7 种问题 × 5 次 + 最难问题再压 20 次,峰值 441 —— 而且峰值来自
        「意图模糊」的问题(模型在拿不准归哪类时想得最久),不是最长的问题;
        原值 10 时 100% 为空、512 时余量只剩 1.2 倍;
      · LLM 精排:峰值 634,且曾观察到 1024 仍被截断(思维链 2700+ 字符),
        所以它走默认预算。
    """
    from app.services.llm import DEFAULT_MAX_TOKENS, SHORT_TASK_MAX_TOKENS

    # 相对实测尾部峰值留足 4 倍以上余量。别把这条断言往小改 ——
    # 预算撞上限时 content 是空串、而且是**静默**走错意图,不会报错。
    MEASURED_TAIL_MAX = 441        # 意图分类实测尾部峰值(见 llm.py 注释)
    assert SHORT_TASK_MAX_TOKENS >= 4 * MEASURED_TAIL_MAX
    assert DEFAULT_MAX_TOKENS > 1024            # 精排那条路用默认预算,必须够


def test_query_rewrite_rejects_fallback_text(monkeypatch):
    """改写拿到兜底话术时,必须退回原问题,而不是把它当成「改写结果」。

    call_deepseek 失败**不抛异常**,而是返回「抱歉,当前服务繁忙…」。不当心的话
    它会被一路带下去:检索层拿这句话去查,召回一堆无关文档;而且 wasRewritten=True
    还会让调用方丢掉原始问题。
    """
    from app.models.chat import ChatHistoryEntry
    from app.services import llm
    from app.services.pipeline import rewrite as rewrite_mod

    monkeypatch.setattr(rewrite_mod, "needsRewrite", lambda *a, **k: True)
    monkeypatch.setattr(rewrite_mod, "call_deepseek", lambda *a, **k: llm.FALLBACK_TEXT)

    history = [ChatHistoryEntry(role="user", content="宝宝发烧了")]
    result = rewrite_mod.rewrite_query("他需要吃药吗", history)

    assert result.wasRewritten is False
    assert result.rewrittenQuery == "他需要吃药吗"      # 退回原问题,不是兜底话术

# —— 检索相关性门控:知识库里没有相关内容时,别把无关文档塞进 prompt ——

def _stub_rag(monkeypatch, ranked_docs):
    """把 get_rag_context 的外部依赖全替换掉,只留门控逻辑是真的。"""
    from types import SimpleNamespace

    from app.services import chat_service

    monkeypatch.setattr(chat_service, "get_history", lambda *a, **k: [])
    monkeypatch.setattr(
        chat_service, "rewrite_query",
        lambda m, h: SimpleNamespace(wasRewritten=False, rewrittenQuery=m),
    )
    monkeypatch.setattr(
        chat_service, "route_intent",
        lambda m: SimpleNamespace(intent="general", prompt=""),
    )
    monkeypatch.setattr(chat_service, "hybrid_search", lambda *a, **k: [])
    monkeypatch.setattr(
        chat_service, "rerank",
        lambda q, docs, top_k: {"rankedDocuments": ranked_docs},
    )


def test_rag_gate_drops_irrelevant_retrieval(monkeypatch):
    """知识库无相关内容时,明确丢弃检索结果,而不是塞进 prompt。

    实测踩过:问「你是谁」时精排照样返回 5 篇儿科文档、分数**全是 0.0**;prompt 里
    又写着「如果参考资料信息不足,请诚实说明」,于是模型回一句「参考资料里没有关于
    "我是谁"的信息」—— 把内部机制说给用户听,还平白多出一整套儿科问诊的架子
    (含「🚨 什么时候去医院：这个问题不用去医院😄」)。
    """
    from app.services.chat_service import get_rag_context

    _stub_rag(monkeypatch, [
        {"id": "d1", "text": "完全无关的儿科文档A", "score": 0.0},
        {"id": "d2", "text": "完全无关的儿科文档B", "score": 0.0},
    ])

    messages, refs, _, _ = get_rag_context("门控测试-无关问题", "sess-gate-a", [], "alice")

    assert refs == []
    assert "完全无关的儿科文档" not in " ".join(m.content for m in messages)


def test_rag_gate_keeps_relevant_retrieval(monkeypatch):
    """相关问题不能被门控误伤 —— 证据被丢掉等于把答案降级成纯模型记忆。"""
    from app.services.chat_service import get_rag_context

    _stub_rag(monkeypatch, [
        {"id": "d1", "text": "宝宝发烧护理指南", "score": 0.96},
        {"id": "d2", "text": "退烧药使用说明", "score": 0.41},
    ])

    messages, refs, _, _ = get_rag_context("门控测试-相关问题", "sess-gate-b", [], "alice")

    assert len(refs) == 2
    assert refs[0].score == 0.96
    assert "宝宝发烧护理指南" in " ".join(m.content for m in messages)


def test_rag_gate_handles_empty_retrieval(monkeypatch):
    """知识库为空(rankedDocuments 是空列表)时不能 500。

    门控用 max() 取最高分,而 max() 遇到空序列会抛 ValueError —— 空库应当走
    「无相关内容」这条分支,而不是把请求打成 500。
    """
    from app.services.chat_service import get_rag_context

    _stub_rag(monkeypatch, [])

    messages, refs, _, _ = get_rag_context("门控测试-空知识库", "sess-gate-c", [], "alice")

    assert refs == []
    assert messages      # prompt 仍然拼得出来
