import json
from app.services.rag import search_docs
from app.services.prompt import buildPrompt
from app.services.llm import call_deepseek, generate_stream

def get_rag_context(user_message: str) -> tuple[str, list[str]]:
    """检索 + 构建 Prompt，返回 (prompt, context_docs)"""
    context_docs = search_docs(user_message)
    prompt = buildPrompt(user_message, context_docs)
    return prompt, context_docs

def execute_rag_pipeline(user_message: str) -> dict:
    """非流式 RAG 管道"""
    prompt, context_docs = get_rag_context(user_message)
    answer = call_deepseek(prompt)
    return {"answer": answer, "references": context_docs}

def execute_rag_stream(user_message: str):
    """流式 RAG 管道（生成器）"""
    prompt, context_docs = get_rag_context(user_message)
    yield f"event: references\ndata: {json.dumps(context_docs, ensure_ascii=False)}\n\n"
    yield from generate_stream(prompt)
    yield f"event: done\ndata: {{}}\n\n"