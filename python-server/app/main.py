from fastapi import FastAPI
from datetime import datetime as Datetime
from datetime import timezone
from dotenv import load_dotenv


# 加载.env文件中的环境变量
load_dotenv()

from fastapi.responses import StreamingResponse
from app.models.chat import ChatRequest, ChatRequestStream, ChatResponse
from app.services.chat_service import execute_rag_pipeline, execute_rag_stream


app = FastAPI()

startTime = Datetime.now()

@app.get("/api/health")
async def health_check():
    utc_now = Datetime.now(timezone.utc)
    return {
        "status": "ok",
        "uptime": round((Datetime.now() - startTime).total_seconds(), 2),
        "timestamp": utc_now.isoformat(),
    }


# 非流式输出
@app.post("/api/chat")
async def chat(request: ChatRequest) -> ChatResponse:
    result = execute_rag_pipeline(request.message)
    return ChatResponse(answer=result["answer"], references=result["references"])

@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequestStream):
    return StreamingResponse(execute_rag_stream(request.message), media_type="text/event-stream")
