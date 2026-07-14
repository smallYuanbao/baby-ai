from pydantic import BaseModel, Field
from typing import Literal, Optional


class ChatHistoryEntry(BaseModel):
    role: Literal["user", "assistant"] # 只能取两个值
    content: str = Field(..., min_length=1)  # 必填，至少1个字符

# ---------- 请求/响应模型 ----------
class ChatRequest(BaseModel):
    message: str
    history: Optional[list[ChatHistoryEntry]] = None

class ChatResponse(BaseModel):
    answer: str
    references: list[str] = []


class RewriteResult(BaseModel): 
    # 原始query
    originalQuery: str 
    # 改写后的query
    rewrittenQuery: str
    # 是否改写成功
    wasRewritten: bool