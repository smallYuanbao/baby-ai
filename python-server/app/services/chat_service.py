import json
from typing import Optional

from fastapi import Request

from app.models.chat import ChatHistoryEntry, ChatMessage, Reference

from app.services.rag.retriever import hybrid_search, hybrid_search_rrf
from app.services.prompt import buildPromptTest
from app.services.llm import call_deepseek, generate_stream_with_interrupt_and_fallback
from app.services.pipeline.rewrite import rewrite_query
from app.services.pipeline.intent import IntentResult, route_intent
from app.services.pipeline.session import add_assitant_message, add_user_message, get_history
from app.services.rag.reranker import rerank

def _build_messages(user_message: str, context_docs: list[str], histroy: Optional[list[ChatHistoryEntry]], intent_result: IntentResult ) -> list[ChatMessage]:
    messages = []

    # 1. System Prompt（独立一条）
    messages.append(ChatMessage(role="system", content=intent_result.prompt))
    # 2. 历史
    if histroy:
        for h in histroy:
            messages.append(ChatMessage(role=h.role, content=h.content))

    # 3. 最后一条 user 消息 — 用 buildPrompt 生成（RAG 上下文 + 问题）
    user_content = buildPromptTest(user_message, context_docs)
    messages.append(ChatMessage(role="user", content=user_content))

    return messages


def get_rag_context(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
) -> tuple[list[ChatMessage], list[str], list[Reference]]:
    """
    检索 + 构建 Prompt。

    Returns:
        messages:    拼好的完整 messages 数组（可直接传给 LLM）
        context_docs: 只含文本的文档列表（给 buildPrompt 用，保持向后兼容）
        references:   带 id + text 的结构化引用列表（返回给前端展示）
    """

    # 1. 取服务端历史（如果客户端没传，用服务端的）
    server_history = get_history(session_id)
    history = client_history if client_history else server_history

    # 2. 改写
    rewrite_result = rewrite_query(user_message, history)
    message = rewrite_result.wasRewritten and rewrite_result.rewrittenQuery or user_message

    # 3. 意图路由
    intent_result = route_intent(message)
    print(f"[意图路由] 类别: {intent_result.intent}")

    # 4. RAG 检索（后）— emergency 跳过
    if intent_result.intent == "emergency":
        context_docs = []
        references = []
    else:
        results = hybrid_search(message, alpha=0.7, top_k=10)

        # RRF 混合检索 → 多召回一些候选
        # results = hybrid_search_rrf(message, top_k=10)

        # 精排：BGE → DeepSeek → 原始距离排序
        ranked_result = rerank(message, results, top_k=5)

        # 文本列表（给 buildPrompt 拼 prompt 用）
        context_docs = [d["text"] for d in ranked_result["rankedDocuments"]]

        # 结构化引用（给前端展示，包含 id + text）
        references = [
            Reference(id=d["id"] or "", text=d["text"])
            for d in ranked_result["rankedDocuments"]
        ]

    # 5. 拼 messages
    messages = _build_messages(message, context_docs, history, intent_result)
    return messages, references



def execute_rag_pipeline(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
) -> dict:
    """非流式 RAG 管道"""
    messages, references = get_rag_context(
        user_message, session_id, client_history,
    )
    answer = call_deepseek(messages)

    # 更新服务端历史
    add_user_message(session_id, user_message)
    add_assitant_message(session_id, answer)

    return {"answer": answer, "references": references}


async def execute_rag_stream(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
    request: Request,
):
    """流式 RAG 管道（异步生成器）"""
    messages, references = get_rag_context(
        user_message, session_id, client_history,
    )

    refs_json = json.dumps(
        [r.model_dump() for r in references],
        ensure_ascii=False,
    )
    yield f"event: references\ndata: {refs_json}\n\n"

    async for chunk in generate_stream_with_interrupt_and_fallback(messages, request):
        yield chunk

    yield f"event: done\ndata: {{}}\n\n"

    add_user_message(session_id, user_message)