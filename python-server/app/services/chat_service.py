import json
from typing import Optional

from app.models.chat import ChatHistoryEntry

from app.services.rag import hybrid_search, hybrid_search_rrf
from app.services.prompt import buildPrompt
from app.services.llm import call_deepseek, generate_stream
from app.services.query_rewrite import rewrite_query

def get_rag_context(user_message: str, histroy: Optional[list[ChatHistoryEntry]]) -> tuple[str, list[str]]:
    """检索 + 构建 Prompt，返回 (prompt, context_docs)"""

    rewrite_message_obj = rewrite_query(user_message, histroy)
    message = user_message
    print("--- rewrite_message_obj ---", rewrite_message_obj)
    if rewrite_message_obj.wasRewritten:
        message = rewrite_message_obj.rewrittenQuery
    # 线性加权
    # results = hybrid_search(message, top_k=5)
    # RRF
    results = hybrid_search_rrf(message, top_k=5)
    context_docs = [r["doc"] for r in results]
    prompt = buildPrompt(message, context_docs)
    return prompt, context_docs



def execute_rag_pipeline(user_message: str, histroy: Optional[list[ChatHistoryEntry]]) -> dict:
    """非流式 RAG 管道"""
    prompt, context_docs = get_rag_context(user_message, histroy)
    answer = call_deepseek(prompt)
    return {"answer": answer, "references": context_docs}

def execute_rag_stream(user_message: str, histroy: Optional[list[ChatHistoryEntry]]):
    """流式 RAG 管道（生成器）"""
    prompt, context_docs = get_rag_context(user_message, histroy)
    yield f"event: references\ndata: {json.dumps(context_docs, ensure_ascii=False)}\n\n"
    yield from generate_stream(prompt)
    yield f"event: done\ndata: {{}}\n\n"