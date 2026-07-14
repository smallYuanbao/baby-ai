from typing import Optional

from openai import OpenAI

from app.core.config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
from app.models.chat import ChatMessage, ChatOptions

# 初始化 DeepSeek 客户端
deepseek_client = OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url=DEEPSEEK_BASE_URL,
)

def call_deepseek(
    messages: list[ChatMessage],
    options: Optional[ChatOptions] = None,
) -> str:
    """调用 DeepSeek 生成回答（非流式）"""
    # options 为 None 时使用空对象，避免访问 None.xxx 报错
    opts = options or ChatOptions()

    response = deepseek_client.chat.completions.create(
        model=opts.model or DEEPSEEK_MODEL,
        messages=[{"role": m.role, "content": m.content} for m in messages],
        temperature=opts.temperature if opts.temperature is not None else 0.7,
        max_tokens=opts.maxTokens if opts.maxTokens is not None else 1000,
        stream=False,
    )

    return response.choices[0].message.content


# 流式输出生成器
def generate_stream(
    messages: list[ChatMessage],
    options: Optional[ChatOptions] = None,
):
    """调用 DeepSeek 生成流式回答"""
    opts = options or ChatOptions()

    stream = deepseek_client.chat.completions.create(
        model=opts.model or DEEPSEEK_MODEL,
        messages=[{"role": m.role, "content": m.content} for m in messages],
        temperature=opts.temperature if opts.temperature is not None else 0.7,
        max_tokens=opts.maxTokens if opts.maxTokens is not None else 1000,
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta