from typing import Optional

from fastapi import Request
from openai import OpenAI, APITimeoutError, APIConnectionError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from app.core.config import (
    DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL,
    FALLBACK_API_KEY, FALLBACK_BASE_URL, FALLBACK_MODEL,
    LLM_TIMEOUT, BREAKER_FAILURE_THRESHOLD, BREAKER_OPEN_TIMEOUT,
)
from app.core.circuit_breaker import CircuitBreaker
from app.models.chat import ChatMessage, ChatOptions
from app.core.cost_tracker import cost_tracker
from app.utils.logger import logger

# 初始化 DeepSeek 客户端（加 timeout，防止无限等待）
deepseek_client = OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url=DEEPSEEK_BASE_URL,
    timeout=LLM_TIMEOUT,
)

# 备用模型客户端（留空位：配置了 FALLBACK_API_KEY 才启用）
# 当前降级策略 = 返回兜底文案；后续配了 key 可在 _fallback_answer 里切换真实备用模型
fallback_client = None
if FALLBACK_API_KEY and FALLBACK_BASE_URL:
    fallback_client = OpenAI(
        api_key=FALLBACK_API_KEY,
        base_url=FALLBACK_BASE_URL,
        timeout=LLM_TIMEOUT,
    )

# 全局熔断器：连续失败 N 次熔断，熔断 open_timeout 秒后半开试探
breaker = CircuitBreaker(
    failure_threshold=BREAKER_FAILURE_THRESHOLD,
    open_timeout=BREAKER_OPEN_TIMEOUT,
)

# 降级兜底文案（不暴露内部错误）
FALLBACK_TEXT = "抱歉，当前服务繁忙，请稍后再试～"


def _fallback_answer() -> str:
    """熔断/调用失败时的降级兜底：保证「有响应」，不暴露内部错误"""
    # TODO: 若 fallback_client 已配置，可在这里切换备用模型再调一次，
    #       把「降级兜底」升级成「备用模型切换」（对应高并发-题4）
    return FALLBACK_TEXT


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    retry=retry_if_exception_type((APITimeoutError, APIConnectionError)),
    reraise=True,
)
def _call_deepseek_raw(messages: list[ChatMessage], options: ChatOptions, stream: bool = False):
    """带超时 + 重试的底层调用（只重试超时/连接错误，不重试业务错误）"""
    return deepseek_client.chat.completions.create(
        model=options.model or DEEPSEEK_MODEL,
        messages=[{"role": m.role, "content": m.content} for m in messages],
        temperature=options.temperature if options.temperature is not None else 0.7,
        max_tokens=options.maxTokens if options.maxTokens is not None else 1000,
        stream=stream,
    )


def call_deepseek(
    messages: list[ChatMessage],
    options: Optional[ChatOptions] = None,
) -> str:
    """调用 DeepSeek 生成回答（非流式），带熔断 + 重试 + 降级"""
    if not breaker.allow_request():
        logger.warning("[熔断] 熔断器拒绝请求，走降级兜底")
        return _fallback_answer()

    opts = options or ChatOptions()
    try:
        response = _call_deepseek_raw(messages, opts, stream=False)
        breaker.record_success()

        if hasattr(response, 'usage') and response.usage:
            cost_tracker.record(
                prompt_tokens=response.usage.prompt_tokens,
                completion_tokens=response.usage.completion_tokens,
            )
        return response.choices[0].message.content
    except Exception as e:
        breaker.record_failure()
        logger.error("[LLM] 调用失败（重试后仍失败）: %s", e)
        return _fallback_answer()


def generate_stream(
    messages: list[ChatMessage],
    options: Optional[ChatOptions] = None,
):
    """调用 DeepSeek 生成流式回答（保留旧接口，带超时）"""
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
    """带熔断 + 中断处理 + 错误兜底的流式生成器"""
    # 1. 熔断器判断：拒绝时直接降级
    if not breaker.allow_request():
        logger.warning("[熔断] 熔断器拒绝流式请求，走降级兜底")
        yield _fallback_answer()
        return

    generated_content = ""
    stream = None
    disconnected = False
    try:
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
                disconnected = True
                logger.warning("[流式] 客户端断开连接，终止生成")
                break
            delta = chunk.choices[0].delta.content
            if delta:
                generated_content += delta
                yield delta
            last_chunk = chunk

        # 正常生成完才记成功；客户端主动断开不计入熔断统计
        if not disconnected:
            breaker.record_success()
            # 最后一个 chunk 包含 usage 信息
            if last_chunk and last_chunk.usage:
                cost_tracker.record(
                    last_chunk.usage.prompt_tokens or 0,
                    last_chunk.usage.completion_tokens or 0,
                )

    except Exception as e:
        breaker.record_failure()
        logger.error("[LLM流式] 调用失败: %s", e)
        if generated_content:
            # 返回已生成的内容 + 错误提示
            yield f"\n\n[生成中断：{str(e)[:100]}，以上为已生成部分]"
        else:
            yield _fallback_answer()
    finally:
        # 无论成功、失败还是中断，确保资源被释放
        if stream is not None:
            stream.close()
