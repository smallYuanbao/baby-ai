
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

    实测(deepseek-v4-flash,均为真实知识库文档/真实提问,不是合成语料):
      · 意图分类:峰值 441 —— 峰值来自「意图模糊」的问题(模型拿不准归哪类时想得最久),
        不是最长的问题;原值 10 时 100% 为空、512 时余量只剩 1.2 倍;
      · 主回答:峰值 2479,4096 只剩 1.7 倍余量;
      · LLM 精排:峰值 5508,4096 只有 0.7 倍(5 次里 2 次撞上限)。
    """
    from app.services.llm import (
        DEFAULT_MAX_TOKENS, RERANK_MAX_TOKENS, SHORT_TASK_MAX_TOKENS,
    )

    # 每档相对自己的实测峰值留 3 倍以上余量。别把这些数字往小改 ——
    # 预算撞上限时 content 是空串、而且是**静默**降级(分类走错意图 / 精排退化成按距离排),不报错。
    MEASURED_PEAKS = {
        "short_task": 441,      # 意图分类
        "main": 2479,           # 主回答(非流式 / 流式)
        "rerank": 5508,         # LLM 精排
    }
    assert SHORT_TASK_MAX_TOKENS >= 3 * MEASURED_PEAKS["short_task"]
    assert DEFAULT_MAX_TOKENS >= 3 * MEASURED_PEAKS["main"]
    assert RERANK_MAX_TOKENS >= 3 * MEASURED_PEAKS["rerank"]
    # 精排吃得比主回答多,两档不能混用
    assert RERANK_MAX_TOKENS > DEFAULT_MAX_TOKENS


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

def _stub_rag(monkeypatch, ranked_docs, tier="bge"):
    """把 get_rag_context 的外部依赖全替换掉,只留门控逻辑是真的。

    tier 默认 "bge"(唯一有绝对相关性的那档);传别的值可验证"门控按 tier 跳过"。
    """
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
    # 检索已从 hybrid_search（线性加权）切到 hybrid_search_rrf，stub 跟着改名
    monkeypatch.setattr(chat_service, "hybrid_search_rrf", lambda *a, **k: [])
    monkeypatch.setattr(
        chat_service, "rerank",
        lambda q, docs, top_k: {"rankedDocuments": ranked_docs, "tier": tier},
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

# —— 非育儿问题（off_topic）意图 ——

def test_meta_question_requires_whole_sentence_match():
    """元问题判定必须「整句相等」,不能用子串或前缀。

    踩过:最早写成 startswith + 长度上限 15,结果「你是谁？我家宝宝晚上总哭闹」
    正好 12 个字,前缀匹配命中 → 一条真育儿问题被判成 off_topic(关键词路径 0.97
    直接采纳),家长拿到的是「我是育儿助手」这种答非所问。
    在育儿/医疗场景里,误判成不答比多套一层回答模板严重得多。
    """
    from app.services.pipeline.intent import _is_meta_question

    # 真·元问题（允许首尾标点/语气词）
    assert _is_meta_question("你是谁") is True
    assert _is_meta_question("你是谁呀") is True
    assert _is_meta_question("你能做什么？") is True
    assert _is_meta_question("介绍一下你自己") is True

    # 危险共现:句子里有元问题措辞、但真正问的是育儿 —— 必须判 False
    assert _is_meta_question("你是谁？我家宝宝晚上总哭闹") is False
    assert _is_meta_question("你能做什么？我想问宝宝辅食") is False
    assert _is_meta_question("你好，宝宝发烧了怎么办") is False


def test_off_topic_uses_standalone_prompt():
    """off_topic 必须用独立 prompt,不能拼 BASE_PROMPT。

    拼回去就等于回到「你是谁 → 🚨 什么时候去医院：这个问题不用去医院😄」那个状态。
    """
    from app.services.pipeline.intent import (
        BASE_PROMPT, INTENT_APPENDS, STANDALONE_PROMPTS, build_system_prompt,
    )

    assert "off_topic" in STANDALONE_PROMPTS
    assert build_system_prompt("off_topic") == INTENT_APPENDS["off_topic"]
    # 不能含 BASE_PROMPT 里那套五段式的**正向**要求
    assert "先给结论**（1-2句核心判断）" not in build_system_prompt("off_topic")
    # 一般育儿意图仍然拼 BASE_PROMPT
    assert build_system_prompt("illness").startswith(BASE_PROMPT)


def test_off_topic_skips_retrieval(monkeypatch):
    """off_topic 不该触发检索。

    知识库里本来就没有这类内容,跑一遍纯属浪费 —— 实测「你是谁」原本要跑完
    BM25 + BGE 精排(单次 24 秒)才被相关性门控拦掉;跳过之后端到端 ~40 秒 → ~2 秒。
    """
    from types import SimpleNamespace

    from app.services import chat_service
    from app.services.chat_service import get_rag_context

    def boom(*a, **k):
        raise AssertionError("off_topic 不该调用检索")

    monkeypatch.setattr(chat_service, "get_history", lambda *a, **k: [])
    monkeypatch.setattr(
        chat_service, "rewrite_query",
        lambda m, h: SimpleNamespace(wasRewritten=False, rewrittenQuery=m),
    )
    monkeypatch.setattr(
        chat_service, "route_intent",
        lambda m: SimpleNamespace(intent="off_topic", prompt=""),
    )
    monkeypatch.setattr(chat_service, "hybrid_search_rrf", boom)
    monkeypatch.setattr(chat_service, "rerank", boom)

    messages, refs, _, _ = get_rag_context("元问题测试", "sess-off-1", [], "alice")

    assert refs == []
    assert messages       # prompt 仍然拼得出来


# —— 混合检索切到 RRF ——

def test_rrf_scores_are_normalized_to_unit_range(monkeypatch):
    """RRF 的原始分只有 0.016~0.033,必须归一化到 0~1 再放进 score。

    不归一化会有两个后果:
      - 前端「相关性」徽章对最好的那条也只显示 3%;
      - 下游相关性门控(阈值 0.1)会把**所有**查询都判成"知识库无内容"。
    """
    import app.services.rag.retriever as retr

    class _Doc:
        def __init__(self, i):
            self.id, self.text = f"d{i}", f"文档{i}"
            self.distance = self.score = self.metadata = None

    # 稠密、稀疏两路各返回 20 条且完全不重叠 —— 保证有稳定可算的 RRF 排名
    monkeypatch.setattr(retr, "search_docs", lambda q, top_k: [_Doc(i) for i in range(20)])
    monkeypatch.setattr(retr, "sparse_search", lambda q, top_k: [_Doc(i) for i in range(20, 40)])

    docs = retr.hybrid_search_rrf("任意查询", top_k=5)

    assert len(docs) == 5
    assert max(d.score for d in docs) == 1.0    # 归一化后最高分为 1.0
    assert min(d.score for d in docs) >= 0.0
    assert all(d.score <= 1.0 for d in docs)

# —— 精排 tier：分数能不能用来做相关性判断的显式契约 ——

def test_rerank_reports_passthrough_tier_when_candidates_fit():
    """候选数 ≤ top_k 时精排被短路,必须显式标成 passthrough。

    这条路径返回的是**粗排分**（相对值），top1 恒为 1.0 —— 门控读它会永远通过。
    原先是靠「粗排取 10 > 精排留 5」这个数量关系侥幸避开的，
    一旦两个数字被改成相等（或知识库很小、候选本来就少）就会静默失效。
    """
    from app.models.chat import RAGDocument
    from app.services.rag.reranker import rerank

    docs = [RAGDocument(id=f"d{i}", text=f"文档{i}", score=0.5) for i in range(3)]

    out = rerank("任意查询", docs, top_k=5)      # 3 <= 5 → 短路，不调 BGE

    assert out["tier"] == "passthrough"
    assert len(out["rankedDocuments"]) == 3


def test_rerank_reports_bge_tier_when_fine_ranking_runs(monkeypatch):
    """BGE 真正跑了才标 "bge" —— 只有这档的分数是绝对相关性。"""
    from app.models.chat import RAGDocument
    from app.services.rag import reranker

    docs = [RAGDocument(id=f"d{i}", text=f"文档{i}") for i in range(10)]
    monkeypatch.setattr(
        reranker, "rerank_with_bge",
        lambda q, d, k: [{"id": "d0", "text": "文档0", "score": 0.9}],
    )

    out = reranker.rerank("任意查询", docs, top_k=5)   # 10 > 5 → 走精排

    assert out["tier"] == "bge"


def test_rag_gate_skipped_when_rerank_degraded(monkeypatch):
    """精排降级时门控必须跳过 —— 那些 tier 的分数不是相关性。

    LLM 排序的分数是 `1 - 排名/top_k` 编出来的、距离兜底和粗排直通都是相对值，
    它们的 top1 恒为 1.0。拿这种分数跟阈值比，结果毫无意义：
    要么永远通过（门控形同虚设），要么哪天归一化方式一改就永远拦截。
    所以按 tier 显式跳过，并打 warning 日志留痕。
    """
    from app.services.chat_service import get_rag_context

    _stub_rag(
        monkeypatch,
        [{"id": "d1", "text": "降级路径返回的文档", "score": 0.0}],   # 分数为 0 也不该被拦
        tier="llm",
    )

    messages, refs, _, _ = get_rag_context("门控测试-降级跳过", "sess-gate-d", [], "alice")

    assert len(refs) == 1     # 没有被门控拦掉
    assert "降级路径返回的文档" in " ".join(m.content for m in messages)
