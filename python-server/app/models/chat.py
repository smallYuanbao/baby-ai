from pydantic import BaseModel

# ---------- 请求/响应模型 ----------
class ChatRequest(BaseModel):
    message: str

class ChatRequestStream(ChatRequest):
    is_stream: bool = True  # 流式响应请求模型

class ChatResponse(BaseModel):
    answer: str
    references: list[str] = []
