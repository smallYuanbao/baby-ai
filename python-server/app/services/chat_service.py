import json
from typing import Optional

from app.models.chat import ChatHistoryEntry, ChatMessage

from app.services.rag import hybrid_search, hybrid_search_rrf
from app.services.prompt import buildPrompt
from app.services.llm import call_deepseek, generate_stream
from app.services.query_rewrite import rewrite_query
from app.services.intent_router import IntentResult, route_intent

def _build_messages(user_message: str, context_docs: list[str], histroy: Optional[list[ChatHistoryEntry]], intent_result: IntentResult ) -> list[ChatMessage]:
    messages = []

    # 1. System Prompt（独立一条）
    messages.append(ChatMessage(role="system", content=intent_result.prompt))
    # 2. 历史
    if histroy:
        for h in histroy:
            messages.append(ChatMessage(role=h.role, content=h.content))

    # 3. 最后一条 user 消息 — 用 buildPrompt 生成（RAG 上下文 + 问题）
    user_content = buildPrompt(user_message, context_docs)
    messages.append(ChatMessage(role="user", content=user_content))

    return messages


def get_rag_context(user_message: str, histroy: Optional[list[ChatHistoryEntry]]) -> tuple[list[ChatMessage], list[str]]:
    """检索 + 构建 Prompt，返回 (prompt, context_docs)"""
    # 1. 改写
    rewrite_result = rewrite_query(user_message, histroy)
    message = rewrite_result.wasRewritten and  rewrite_result.rewrittenQuery or user_message
    print("--- rewrite_result ---", rewrite_result)

    # 2. 意图路由
    intent_result = route_intent(message)

    print(f"[意图路由] 类别: {intent_result.intent}")

    # 3. RAG 检索（后）— emergency 跳过
    if intent_result.intent == "emergency":
        context_docs = []
    else:
        # 线性加权
        # results = hybrid_search(message, top_k=5)
        # RRF
        results = hybrid_search_rrf(message, top_k=5)
        context_docs = [r["doc"] for r in results]

    # 4. 拼messages
    messages= _build_messages(message, context_docs, histroy, intent_result)
    return messages, context_docs



def execute_rag_pipeline(user_message: str, histroy: Optional[list[ChatHistoryEntry]]) -> dict:
    """非流式 RAG 管道"""
    messages, context_docs = get_rag_context(user_message, histroy)
    answer = call_deepseek(messages)
    return {"answer": answer, "references": context_docs}

def execute_rag_stream(user_message: str, histroy: Optional[list[ChatHistoryEntry]]):
    """流式 RAG 管道（生成器）"""
    messages, context_docs = get_rag_context(user_message, histroy)
    yield f"event: references\ndata: {json.dumps(context_docs, ensure_ascii=False)}\n\n"
    yield from generate_stream(messages)
    yield f"event: done\ndata: {{}}\n\n"