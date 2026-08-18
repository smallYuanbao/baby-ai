from app.utils.logger import logger


class CostTracker:
    """
    Token 用量与成本追踪器

    功能：
    1. 记录每次 LLM 调用的 Token 消耗
    2. 提供当日成本估算
    """

    def __init__(self):
        self.daily_prompt_tokens = 0
        self.daily_completion_tokens = 0

    # ---- Token 记录 ----
    def record(self, prompt_tokens: int, completion_tokens: int):
        """记录一次 LLM 调用的 Token 消耗"""
        self.daily_prompt_tokens += prompt_tokens
        self.daily_completion_tokens += completion_tokens
        logger.info("消耗用量 | prompt_tokens=%s, completion_tokens=%s", prompt_tokens, completion_tokens)

    # ---- 成本估算 ----

    def get_daily_cost(self) -> dict:
        """
        返回当日费用估算（单位：元）
        DeepSeek 参考价格：
        - 输入：¥1 / 百万 Token
        - 输出：¥2 / 百万 Token
        """

        input_cost = self.daily_prompt_tokens / 1_000_000 * 1.0
        output_cost = self.daily_completion_tokens / 1_000_000 * 2.0

        return {
            "prompt_tokens": self.daily_prompt_tokens,
            "completion_tokens": self.daily_completion_tokens,
            "total_tokens": self.daily_prompt_tokens + self.daily_completion_tokens,
            "estimated_cost_yuan": round(input_cost + output_cost, 6)
        }


# 全局单例，所有 LLM 调用共享
cost_tracker = CostTracker()
