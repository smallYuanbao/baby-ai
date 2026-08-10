from typing import Optional

from fastapi import Request
from openai import OpenAI

from app.core.config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
from app.models.chat import ChatMessage, ChatOptions
from app.core.cost_tracker import cost_tracker
from app.utils.logger import logger

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

    if hasattr(response, 'usage') and response.usage:
        cost_tracker.record(
            prompt_tokens=response.usage.prompt_tokens,
            completion_tokens=response.usage.completion_tokens
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


async def generate_stream_with_interrupt_and_fallback(
    messages: list[ChatMessage],
    request: Request,
    options: Optional[ChatOptions] = None,
):
    """带中断处理和错误兜底的流式生成器"""

    generated_content = ""
    try:
        """调用 DeepSeek 生成流式回答"""
        opts = options or ChatOptions()
    
        stream = deepseek_client.chat.completions.create(
            model=opts.model or DEEPSEEK_MODEL,
            messages=[{"role": m.role, "content": m.content} for m in messages],
            temperature=opts.temperature if opts.temperature is not None else 0.7,
            max_tokens=opts.maxTokens if opts.maxTokens is not None else 1000,
            stream=True,
        )

        last_chunk = None
        for chunk in stream:
            if await request.is_disconnected():
                logger.warning("[流式] 客户端断开连接，终止生成")
                break
            delta = chunk.choices[0].delta.content
            if delta:
                generated_content += delta
                yield delta
            last_chunk = chunk

        # 最后一个 chunk 包含 usage 信息
        if last_chunk and last_chunk.usage:
            cost_tracker.record(
                last_chunk.usage.prompt_tokens or 0,
                last_chunk.usage.completion_tokens or 0,
            )

    except Exception as e:
        if generated_content:
            # 返回已生成的内容 + 错误提示
            yield f"\n\n[生成中断：{str(e)[:100]}，以上为已生成部分]"
        else:
            yield f"抱歉，服务暂时不可用，请稍后重试。"
    finally:
        # 无论成功、失败还是中断，确保资源被释放
        stream.close()