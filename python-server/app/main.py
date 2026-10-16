import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Request, File, UploadFile, Depends, HTTPException
from datetime import datetime as Datetime
from datetime import timezone

from fastapi.responses import StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from app.core.auth import ANONYMOUS_USER, get_current_user_id
from app.core.config import CHAT_RATE_LIMIT
from app.models.chat import ChatRequest, ChatResponse
from app.services.chat_service import execute_rag_pipeline, execute_rag_stream
from app.services.agent import MCPClient, agent_chat, agent_chat_mcp, mutil_agent_pipeline, react_agent_chat, react_agent_with_reflection, unified_agent
from app.services.upload_service import process_upload
from app.api.growth import router as growth_router
from app.api.play import router as play_router
from app.core.cost_tracker import cost_tracker


mcp_client = None

app = FastAPI()

def _rate_limit_key(request: Request) -> str:
    """限流分桶的键:**按用户,不按 IP**。

    按 IP 会误伤:公司/学校 NAT 后的多个用户共用一个出口 IP、互相抢额度;
    本地开发时全是 127.0.0.1,整台机器共用一个桶。既然已经用 user_id 做了多租户隔离,
    限流就该跟上这个维度——否则隔离做了、限额没做,一半一半。

    匿名请求退回按 IP 分桶:不然所有匿名用户挤同一个桶,一个人刷就把别人挡了。
    凭据无效的交给鉴权层返回 401,这里只管分桶,不重复判。
    """
    try:
        uid = get_current_user_id(request.headers.get("authorization"))
    except HTTPException:
        uid = ANONYMOUS_USER
    return uid if uid != ANONYMOUS_USER else f"ip:{get_remote_address(request)}"


# 限流中间件:超限返回 429(对应高并发-题5 恶意请求限流)
# 额度走配置(CHAT_RATE_LIMIT),本地/评测环境可调宽,不改代码。
limiter = Limiter(key_func=_rate_limit_key)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

start_time = Datetime.now()

# 业务子路由（growth / play 模块化路由）
app.include_router(growth_router)
app.include_router(play_router)

# 服务身份标识。
#
# 为什么值得单独一个常量:多项目并行开发时,端口撞车是必然的,而
# **只返回 {"status": "ok"} 的健康检查无法回答"对面是谁"** —— 任何一个
# FastAPI 服务(比如 evalflow)都会这么答。于是前端静默连到别人的后端时,
# 症状表现为「某些接口 404 / 数据明显不对」,会被误当成业务 bug 查很久。
#
# 带上这个名字之后,scripts/devguard.mjs 能在启动前直接告诉你
# 「8010 上坐的是 evalflow,不是 baby-ai」。改前端端口/代理时**别改这个名字**。
SERVICE_NAME = "baby-ai"


@app.get("/api/health")
async def health_check():
    utc_now = Datetime.now(timezone.utc)
    return {
        "service": SERVICE_NAME,
        "status": "ok",
        "uptime": round((Datetime.now() - start_time).total_seconds(), 2),
        "timestamp": utc_now.isoformat(),
    }


def _git_commit() -> str | None:
    """当前代码版本(短 commit)。取不到返回 None——不编假值。

    为什么重要:检索参数(top_k / alpha / RRF 的 k)是硬编码在函数签名里的,不读 env,
    所以「代码版本」才是检索行为的主要标识。
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],  # 仓库根
            capture_output=True, text=True, timeout=2,
        )
        return out.stdout.strip() or None if out.returncode == 0 else None
    except Exception:
        return None  # 没装 git / 非 git 目录 → 显式 None


def _collection_counts() -> dict:
    """各知识库集合的文档数(数据状态)。集合不存在记 None,整体失败也记 None。"""
    from app.core.config import CHROMA_USER_UPLOAD_COLLECTION, COLLECTION_NAME, SEARCH_COLLECTIONS
    from app.services.rag.embedding import chroma_client

    counts: dict = {}
    for name in [COLLECTION_NAME, *SEARCH_COLLECTIONS, CHROMA_USER_UPLOAD_COLLECTION]:
        try:
            counts[name] = chroma_client.get_collection(name).count()
        except Exception:
            counts[name] = None  # 集合不存在
    return counts


@app.get("/api/meta")
def meta():
    """被测系统状态(EvalFlow 评测平台用):暴露自身版本与配置,让「这次比上次好」可追溯。

    没有这个接口,EvalFlow 只能记到自己那半边——run 之间分数变了也说不清是「改了检索」
    还是「知识库/模型变了」,「回归」就只是一句话而不是结论。

    只读、不含密钥。拿不到的字段显式给 None（并附 *_error），**不用空值假装已知**——
    静默记空比不记更危险:会让人误信这次结果可与历史对比。
    """
    from app.core.config import DEEPSEEK_MODEL, OLLAMA_MODEL, QUERY_REWRITE_ENABLED, RERANKER_URL

    try:
        collections = _collection_counts()
        collections_error = None
    except Exception as e:
        collections, collections_error = None, f"{type(e).__name__}: {e}"

    return {
        "service": "baby-ai",
        "commit": _git_commit(),
        "model": DEEPSEEK_MODEL,
        "embed_model": OLLAMA_MODEL,
        "query_rewrite": QUERY_REWRITE_ENABLED,
        "reranker_url": RERANKER_URL,
        "collections": collections,
        "collections_error": collections_error,
    }


# 文件上传：解析 → 清洗 → 分块 → 向量化 → 入库 ChromaDB（供 RAG 检索）
# 返回前端契约（驼峰字段），对齐 client 的 UploadResponse 类型
@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), user_id: str = Depends(get_current_user_id)):
    result = process_upload(file, user_id)
    return {
        "fileId": result["file_id"],
        "originalName": file.filename,
        "mimeType": file.content_type,
        "size": result["size"],
        "chunksCount": result["chunks_count"],
    }


# 非流式输出
@app.post("/api/chat")
@limiter.limit(CHAT_RATE_LIMIT)
def chat(payload: ChatRequest, request: Request, user_id: str = Depends(get_current_user_id)) -> ChatResponse:
    result = execute_rag_pipeline(payload.message, payload.session_id, payload.history, user_id, payload.file_id)
    return ChatResponse(answer=result["answer"], references=result["references"])


@app.post("/api/chat/stream")
@limiter.limit(CHAT_RATE_LIMIT)
async def chat_stream(chat_req: ChatRequest, request: Request, user_id: str = Depends(get_current_user_id)):       # ← 多一个参数
    return StreamingResponse(
        execute_rag_stream(
            chat_req.message,
            chat_req.session_id,
            chat_req.history,
            request,
            user_id,
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