from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, File, UploadFile
from datetime import datetime as Datetime
from datetime import timezone

from fastapi.responses import StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from app.models.chat import ChatRequest, ChatResponse
from app.services.chat_service import execute_rag_pipeline, execute_rag_stream
from app.services.agent import MCPClient, agent_chat, agent_chat_mcp, mutil_agent_pipeline, react_agent_chat, react_agent_with_reflection, unified_agent
from app.services.upload_service import process_upload
from app.api.growth import router as growth_router
from app.api.play import router as play_router
from app.core.cost_tracker import cost_tracker


mcp_client = None

app = FastAPI()

# 限流中间件：基于客户端 IP，超限返回 429（对应高并发-题5 恶意请求限流）
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

start_time = Datetime.now()

# 业务子路由（growth / play 模块化路由）
app.include_router(growth_router)
app.include_router(play_router)

@app.get("/api/health")
async def health_check():
    utc_now = Datetime.now(timezone.utc)
    return {
        "status": "ok",
        "uptime": round((Datetime.now() - start_time).total_seconds(), 2),
        "timestamp": utc_now.isoformat(),
    }


# 文件上传：解析 → 清洗 → 分块 → 向量化 → 入库 ChromaDB（供 RAG 检索）
# 返回前端契约（驼峰字段），对齐 client 的 UploadResponse 类型
@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    result = process_upload(file)
    return {
        "fileId": result["file_id"],
        "originalName": file.filename,
        "mimeType": file.content_type,
        "size": result["size"],
        "chunksCount": result["chunks_count"],
    }


# 非流式输出
@app.post("/api/chat")
@limiter.limit("10/minute")
def chat(payload: ChatRequest, request: Request) -> ChatResponse:
    result = execute_rag_pipeline(payload.message, payload.session_id, payload.history, payload.file_id)
    return ChatResponse(answer=result["answer"], references=result["references"])


@app.post("/api/chat/stream")
@limiter.limit("10/minute")
async def chat_stream(chat_req: ChatRequest, request: Request):       # ← 多一个参数
    return StreamingResponse(
        execute_rag_stream(
            chat_req.message,
            chat_req.session_id,
            chat_req.history,
            request,
            chat_req.file_id,
        ),
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



@app.post("/api/agent/multi")
def multi_agent_chat(request: ChatRequest):
    result = mutil_agent_pipeline(request.message, request.session_id, request.history)
    return result


import threading
_lock = threading.Lock()

@app.post("/api/agent/unified")
async def unified_agent_chat(request: ChatRequest):
    global mcp_client
    if mcp_client is None:
        with _lock:
            # 双重检查：拿到锁后再确认一次，防止两个请求同时抢到 None
            if mcp_client is None:
                mcp_client = MCPClient()
                import os
                script = os.path.abspath("../mcp-server/weather_server.py")
                mcp_client.connect_sync(script)
    result = unified_agent(request.message, request.session_id, request.history, mcp_client)
    return result

# 用量信息
@app.get("/api/admin/cost")
def get_cost():
    return cost_tracker.get_daily_cost()