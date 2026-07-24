from contextlib import asynccontextmanager
from fastapi import FastAPI
from datetime import datetime as Datetime
from datetime import timezone

from fastapi.responses import StreamingResponse
from app.models.chat import ChatRequest, ChatResponse
from app.services.chat_service import execute_rag_pipeline, execute_rag_stream
from app.services.agent import MCPClient, agent_chat, agent_chat_mcp, react_agent_chat, react_agent_with_reflection


mcp_client = None

app = FastAPI()

start_time = Datetime.now()

@app.get("/api/health")
async def health_check():
    utc_now = Datetime.now(timezone.utc)
    return {
        "status": "ok",
        "uptime": round((Datetime.now() - start_time).total_seconds(), 2),
        "timestamp": utc_now.isoformat(),
    }


# 非流式输出
@app.post("/api/chat")
def chat(request: ChatRequest) -> ChatResponse:
    result = execute_rag_pipeline(request.message, request.session_id, request.history)
    return ChatResponse(answer=result["answer"], references=result["references"])


@app.post("/api/chat/stream")
def chat_stream(request: ChatRequest):
    return StreamingResponse(
        execute_rag_stream(request.message, request.session_id, request.history),
        media_type="text/event-stream",
    )


@app.post("/api/agent/chat")
def agent_chat_endpoint(request: ChatRequest):
    answer = agent_chat(request.message)
    return {"answer": answer}


@app.post("/api/agent/react")
def agent_call(request: ChatRequest):
    answer = react_agent_chat(request.message)
    return {"answer": answer}


@app.post("/api/agent/reflect")
def reflect_chat(request: ChatRequest):
    answer = react_agent_with_reflection(request.message)
    return {"answer": answer}


import threading
_lock = threading.Lock()

@app.post("/api/agent/mcp")
async def mcp_agent_chat(request: ChatRequest):
    global mcp_client
    if mcp_client is None:
        with _lock:
            # 双重检查：拿到锁后再确认一次，防止两个请求同时抢到 None
            if mcp_client is None:
                mcp_client = MCPClient()
                import os
                script = os.path.abspath("../mcp-server/weather_server.py")
                mcp_client.connect_sync(script)
    answer = await agent_chat_mcp(request.message, mcp_client)
    return {"answer": answer}
