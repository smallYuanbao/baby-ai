"""上传文件归类 + 带附件意图路由的测试。

覆盖两件事：
1. `classify_uploaded_file` 的**降级契约** —— 任何失败都必须返回 `(None, None)`
   （"不知道"），而且**绝不能让上传失败**。这一条比"解析成功"更重要：
   分类只是增强，挂掉不该连累上传。
2. `route_intent(question, file_context)` —— 有摘要时判断依据要升级成「问题 + 文件」。
"""


# ===========================================================================
#  classify_uploaded_file
# ===========================================================================

def test_classify_parses_valid_json(monkeypatch):
    from app.services import upload_classify as uc

    monkeypatch.setattr(
        uc, "call_deepseek",
        lambda messages, options: '{"summary": "一份宝宝体检报告", "parenting_related": true}',
    )
    summary, related = uc.classify_uploaded_file("身高 70cm，体重 8.5kg", "体检.pdf")
    assert summary == "一份宝宝体检报告"
    assert related is True


def test_classify_tolerates_markdown_fence(monkeypatch):
    """模型常把 JSON 裹在 ```json 里 —— 必须照样抠得出来。"""
    from app.services import upload_classify as uc

    monkeypatch.setattr(
        uc, "call_deepseek",
        lambda messages, options: '```json\n{"summary": "前端简历", "parenting_related": false}\n```',
    )
    summary, related = uc.classify_uploaded_file("工作经历：…", "简历.pdf")
    assert summary == "前端简历"
    assert related is False


def test_classify_empty_text_is_unknown(monkeypatch):
    """正文为空时不调模型，直接记"不知道"（省一次调用）。"""
    from app.services import upload_classify as uc

    called = {"n": 0}
    monkeypatch.setattr(uc, "call_deepseek", lambda *a, **k: called.__setitem__("n", called["n"] + 1))

    assert uc.classify_uploaded_file("   \n\n  ", "空.pdf") == (None, None)
    assert called["n"] == 0


def test_classify_garbage_output_is_unknown(monkeypatch):
    from app.services import upload_classify as uc

    monkeypatch.setattr(uc, "call_deepseek", lambda *a, **k: "抱歉，我无法判断这份文件。")
    assert uc.classify_uploaded_file("正文", "x.pdf") == (None, None)


def test_classify_llm_failure_never_raises(monkeypatch):
    """分类挂了不能让上传跟着挂 —— 这是这条链路的硬约束。"""
    from app.services import upload_classify as uc

    def boom(*a, **k):
        raise RuntimeError("上游超时")

    monkeypatch.setattr(uc, "call_deepseek", boom)
    assert uc.classify_uploaded_file("正文", "x.pdf") == (None, None)


def test_classify_rejects_non_boolean_related(monkeypatch):
    """模型回 "true" / "是" 这类字符串时记成"不知道"，不猜。

    把未知硬当成 False，会让一份本该被认真对待的育儿资料被无理由冷落。
    """
    from app.services import upload_classify as uc

    monkeypatch.setattr(
        uc, "call_deepseek",
        lambda *a, **k: '{"summary": "体检报告", "parenting_related": "true"}',
    )
    summary, related = uc.classify_uploaded_file("正文", "体检.pdf")
    assert summary == "体检报告"
    assert related is None


# ===========================================================================
#  format_file_context
# ===========================================================================

def test_format_file_context_three_states():
    from app.services.upload_classify import format_file_context

    related = format_file_context(
        {"filename": "体检.pdf", "summary": "宝宝体检报告", "parenting_related": True}
    )
    assert "体检.pdf" in related and "与育儿相关" in related

    unrelated = format_file_context(
        {"filename": "简历.pdf", "summary": "前端简历", "parenting_related": False}
    )
    assert "与育儿无关" in unrelated

    # 什么都没判出来 → 返回 None，让门控退回只看问题文本（而不是拿到一句废话）
    assert format_file_context(
        {"filename": "x.pdf", "summary": None, "parenting_related": None}
    ) is None
    assert format_file_context(None) is None


def test_format_file_context_keeps_summary_when_relation_unknown():
    """判定未知、但有摘要时，摘要仍然有用（门控能据此推断文件类型）。"""
    from app.services.upload_classify import format_file_context

    text = format_file_context(
        {"filename": "x.pdf", "summary": "宝宝疫苗记录", "parenting_related": None}
    )
    assert text and "宝宝疫苗记录" in text


# ===========================================================================
#  route_intent(question, file_context)
# ===========================================================================

def test_route_intent_passes_file_context_to_classifier(monkeypatch):
    """有摘要时：判断依据升级成「问题 + 文件」，并且能落进 file_qa 档。"""
    from app.services.pipeline import intent as it

    captured = {}

    def fake_llm(question, file_context=None):
        captured["question"] = question
        captured["file_context"] = file_context
        return "file_qa"

    monkeypatch.setattr(it, "classify_by_llm", fake_llm)
    monkeypatch.setattr(it, "classify_by_keyword", lambda q: None)  # 逼它走 LLM 路径

    result = it.route_intent("帮我看看", "用户附上了一份文件：体检.pdf；判断：与育儿相关")

    assert result.intent == "file_qa"
    assert captured["file_context"] is not None
    assert result.prompt == it.build_system_prompt("file_qa")


def test_route_intent_without_file_context_is_unchanged(monkeypatch):
    """没附件时行为必须和以前完全一致 —— 这条改动不该影响普通聊天。"""
    from app.services.pipeline import intent as it

    captured = {}

    def fake_llm(question, file_context=None):
        captured["file_context"] = file_context
        return "general"

    monkeypatch.setattr(it, "classify_by_llm", fake_llm)
    monkeypatch.setattr(it, "classify_by_keyword", lambda q: None)

    result = it.route_intent("宝宝晚上睡不好")
    assert captured["file_context"] is None
    assert result.intent == "general"


def test_file_qa_is_a_standalone_prompt():
    """file_qa 不与育儿五段式 BASE_PROMPT 拼接 —— 否则读文件会很别扭。"""
    from app.services.pipeline.intent import BASE_PROMPT, build_system_prompt

    prompt = build_system_prompt("file_qa")
    assert prompt != BASE_PROMPT
    assert not prompt.startswith(BASE_PROMPT[:40])
