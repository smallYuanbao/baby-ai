from pydantic import BaseModel, Field
from typing import Any, Literal, Optional


class ChatHistoryEntry(BaseModel):
    role: Literal["user", "assistant"] # 只能取两个值
    content: str = Field(..., min_length=1)  # 必填，至少1个字符

# ---------- 请求/响应模型 ----------
class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    history: Optional[list[ChatHistoryEntry]] = None
    session_id: str
    file_id: Optional[str] = None  # 用户上传文件的 ID，命中则额外检索该文件内容

class Reference(BaseModel):
    id: str     # 文档在 ChromaDB 中的唯一 ID（如 med_fbacde39）
    text: str   # 文档内容（截断展示）

class ChatResponse(BaseModel):
    answer: str
    references: list[Reference] = []


class ChatOptions(BaseModel):
    # 模型名称。
    # 覆盖默认的 config.deepseek.model（通常为 deepseek-chat）。
    # 可选值参考 DeepSeek 官方文档，如 deepseek-chat、deepseek-reasoner。
    model: Optional[str] = None
    # 可选值参考 DeepSeek 官方文档，如 deepseek-chat、deepseek-reasoner。
    # - 接近 0：输出更确定、一致，适合事实问答和分类任务。
    # - 接近 1+：输出更具创造性和多样性，适合故事生成和对话。
    temperature: Optional[float] = None
    # 最大输出 token 数。
    # 默认 2048。设得太小可能导致回复被截断（finish_reason = 'length'），
    # 设得太大可能影响响应延迟。建议根据场景调整：
    # - 分类/改写任务：256-512
    # - 一般对话：1024-2048
    # - 长文生成：4096+
    maxTokens: Optional[int] = None
    # 是否启用流式输出。
    # 仅在 `chatStream` 中生效（内部固定为 `true`），`chat` 函数内部固定为 `false`。
    # 调用方一般不需要手动设置此字段。
    stream: Optional[bool] = None


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str

class RewriteResult(BaseModel): 
    # 原始query
    originalQuery: str 
    # 改写后的query
    rewrittenQuery: str
    # 是否改写成功
    wasRewritten: bool

class RAGDocument(BaseModel):
    id: str = ""                              # 默认空，hybrid_search_rrf 等无 ChromaDB id 的场景
    text: str
    metadata: Optional[dict[str, Any]] = None # 默认 None，hybrid_search_rrf 等无元数据的场景
    distance: Optional[float] = None
    score: Optional[float] = None
