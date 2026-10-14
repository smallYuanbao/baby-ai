from typing import Optional

from fastapi import Request
from openai import AsyncOpenAI, OpenAI, APITimeoutError, APIConnectionError
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
def create_completion(**kwargs):
    """**统一的 completions.create 出口**(带 token/成本统计)。

    Agent 与记忆路径原来直接调 `deepseek_client.chat.completions.create`,
    **绕开了 cost_tracker** —— 结果是那些路径烧的钱一笔都没记上,
    账目严重低估。这和 max_tokens 漏 Agent 路径是**同一个根因:绕开公共出口**。

    新代码一律走这里;直接调 deepseek_client 的地方都需要一个理由。
    """
    r = deepseek_client.chat.completions.create(**kwargs)
    if getattr(r, "usage", None):
        cost_tracker.record(
            prompt_tokens=r.usage.prompt_tokens,
            completion_tokens=r.usage.completion_tokens,
        )
    return r


deepseek_client = OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url=DEEPSEEK_BASE_URL,
    timeout=LLM_TIMEOUT,
)

# 流式专用：异步客户端。
#
# 为什么必须单独开一个：流式接口（/api/chat/stream、成长分析、讲故事）都是
# async def + async 生成器，事件循环上跑的。而同步的 OpenAI 客户端每读一个
# chunk 都是一次阻塞的网络调用，会**把整个事件循环按住在那里**——
# 实测：一个聊天请求进行中，/api/health 从 1.3ms 变成 38.2 秒才返回，
# 期间所有其他请求（包括前端刚发起的下一个提问）全部排队干等。
# 换成 AsyncOpenAI + async for，await 点交还控制权，循环不再被占住。
async_deepseek_client = AsyncOpenAI(
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

# 默认输出预算。**必须按「推理模型」来定**:
# deepseek-v4-flash 是推理模型,会先输出 reasoning_content(思维链)再输出 content,
# 两者**共用** max_tokens。原值 1000 是给非推理模型定的——真实 RAG prompt(约 3000 字符证据)
# 下思维链本身就要 1000+ token,预算被吃光 → content 为空、finish_reason=length。
# 实测:16 条评测样本里 5 条(31%)因此拿到空回答,再连锁污染缓存与会话历史。
# 4096 给思维链和正式回答都留出余量。
DEFAULT_MAX_TOKENS = 4096

# 一定要给一个词的短任务的输出预算（当前只有意图分类用）。
#
# 这类任务看着「输出很短」，很容易顺手把 max_tokens 定成 10 这种数。
# **但当前模型是推理模型，思维链和正式回答共用这个额度**：
# 预算给不够时，思维链先把额度烧完，finish_reason=length，content 直接是空串。
#
# 实测（deepseek-v4-flash，7 种问题 × 5 次 + 最难问题再压 20 次，
# 记录 completion_tokens 实际用量）：
#   · 短问题（8~12 字）        中位 64    峰值 100
#   · 长问题（402 字）         中位 129   峰值 129   ← 问题长 ≠ 想得久
#   · **意图模糊的问题**（35 字）中位 169   **峰值 441**  ← 真正的峰值来源
#
# 最后一行是关键：峰值**不是**来自最长的问题，而是来自「疫苗发烧 + 拉肚子 + 辅食
# 要不要停」这种横跨多个类别、模型拿不准该归哪类的问题 —— 它在取舍时想得最久。
# 同一个问题反复跑还会飘（20 次里从 100 到 441）。
#
# 所以 512 那种「留一点余量」的定法是不够的：441 离 512 只差 71 个 token（1.2 倍），
# 再难一点就撞上限、content 变空串、分类静默走错。2048 相对峰值留 4.6 倍余量。
#
# 注意：**不能用这个常量去套所有「输出很短」的任务**。LLM 精排的输出也只有几个
# 数字，但它要模型读十几篇候选文档再比对，实测峰值 634（8 次采样全部正常收敛），
# 那种任务请直接用 DEFAULT_MAX_TOKENS。
#
# 顺带一提：max_tokens 只是上限，**按实际用量计费**，给宽不会多花钱；
# 定小了却会静默拿到空回答，那才是真亏。
SHORT_TASK_MAX_TOKENS = 2048


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
        max_tokens=options.maxTokens if options.maxTokens is not None else DEFAULT_MAX_TOKENS,
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

        content = response.choices[0].message.content
        # **空内容按失败处理**:上游偶尔返回空(超时/截断/空 completion)。
        # 不能把它当正常结果传下去——空答案会连锁污染:
        #   ① 答案缓存把空串存下来 → 之后所有相同提问都命中这条空答案;
        #   ② 会话历史存进 content='' → 该会话的后续请求在 ChatHistoryEntry 校验时 500。
        # (实测:3/16 条样本回答为空,并伴随后续请求 500。)
        if not (content or "").strip():
            breaker.record_failure()
            # 分两种情况报，不然排查时会被误导：
            #   finish_reason=length → **我们自己**的 max_tokens 给小了，思维链把额度
            #     吃光，content 才空的。这是配置问题，调大预算即可，不是上游故障。
            #   finish_reason=stop → 上游确实返回了空，这才是真的异常。
            # 原先两种情况共用一句「上游返回空内容」，让人一直往上游找原因。
            if response.choices[0].finish_reason == "length":
                logger.warning(
                    "[LLM] 输出预算被思维链吃光(content 为空, finish_reason=length)。"
                    "max_tokens=%s —— 推理模型的思维链与正文共用该额度,调大它,"
                    "短任务请用 SHORT_TASK_MAX_TOKENS",
                    opts.maxTokens if opts.maxTokens else DEFAULT_MAX_TOKENS,
                )
            else:
                logger.warning("[LLM] 上游返回空内容,按失败处理并降级")
            return _fallback_answer()

        if hasattr(response, 'usage') and response.usage:
            cost_tracker.record(
                prompt_tokens=response.usage.prompt_tokens,
                completion_tokens=response.usage.completion_tokens,
            )
        return content
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
        # 注意用 opts 而不是 options：options 可能是 None（上面那行才兜的底），
        # 直接用 options.maxTokens 会 AttributeError，整条流式回答直接降级成兜底话术。
        max_tokens=opts.maxTokens if opts.maxTokens is not None else DEFAULT_MAX_TOKENS,
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
    """带熔断 + 中断处理 + 错误兜底的流式生成器（真异步）"""
    # 1. 熔断器判断：拒绝时直接降级
    if not breaker.allow_request():
        logger.warning("[熔断] 熔断器拒绝流式请求，走降级兜底")
        yield _fallback_answer()
        return

    # 2. 开跑之前先看一眼客户端还在不在。
    #    检索阶段可能已经花掉几十秒，用户很可能在这期间就点了「停止」；
    #    这时直接放弃，省下一次完整的 LLM 调用（既省钱也省时间）。
    if await request.is_disconnected():
        logger.info("[流式] 客户端已断开，跳过 LLM 调用")
        return

    generated_content = ""
    stream = None
    disconnected = False
    try:
        opts = options or ChatOptions()
        # AsyncOpenAI：这一行的 await 就把控制权交还给事件循环了，
        # 之后每个 chunk 的等待也都在 await 上，不再阻塞其他请求。
        stream = await async_deepseek_client.chat.completions.create(
            model=opts.model or DEEPSEEK_MODEL,
            messages=[{"role": m.role, "content": m.content} for m in messages],
            temperature=opts.temperature if opts.temperature is not None else 0.7,
            # 同上：必须用 opts，否则 options=None 时抛 AttributeError。
            max_tokens=opts.maxTokens if opts.maxTokens is not None else DEFAULT_MAX_TOKENS,
            stream=True,
        )

        last_chunk = None
        async for chunk in stream:
            # 其余 await 点之间也要查：客户端可能在生成到一半时点了停止
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
        # 无论成功、失败还是中断，确保资源被释放（异步 stream 的 close 也要 await）。
        # 这里套 try 是因为生成器被提前关闭时，finally 里再 await 可能抛
        # GeneratorExit 相关异常，不能让它盖掉真正的错误。
        if stream is not None:
            try:
                await stream.close()
            except Exception as e:
                logger.debug("[流式] 关闭上游流时出错(忽略): %s", e)
