from fastapi import FastAPI
from datetime import datetime as Datetime
from datetime import timezone

from fastapi.responses import StreamingResponse
from app.models.chat import ChatRequest, ChatResponse
from app.services.chat_service import execute_rag_pipeline, execute_rag_stream
from app.services.agent import agent_chat


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
def chat(request: ChatRequest) -> ChatResponse:
    result = execute_rag_pipeline(request.message, request.session_id, request.history)
    return ChatResponse(answer=result["answer"], references=result["references"])

@app.post("/api/chat/stream")
def chat_stream(request: ChatRequest):
    return StreamingResponse(execute_rag_stream(request.message, request.session_id, request.history), media_type="text/event-stream")


@app.post("/api/agent/chat")
def agent_chat_endpoint(request: ChatRequest):
    answer = agent_chat(request.message)
    return {"answer": answer}
