import re
from typing import Optional

from app.core.config import QUERY_REWRITE_ENABLED
from app.models.chat import RewriteResult, ChatHistoryEntry, ChatMessage
from app.services.llm import FALLBACK_TEXT, call_deepseek
from app.utils.logger import logger

PRONOUN_PATTERN = re.compile(r"他|她|它|他们|她们|它们|这些|那些|这个|那个|这里|那里|这样|那样")


def needsRewrite(message: str, histroy: Optional[list[ChatHistoryEntry]]) -> bool:
    if not QUERY_REWRITE_ENABLED:
        return False
    if not histroy or len(histroy) == 0:
        return False
    return PRONOUN_PATTERN.search(message)


def get_display_role(role: str) -> str:
    return "用户" if role == "user" else "助手"


def rewrite_query(message: str, histroy: list[ChatHistoryEntry]) -> RewriteResult:
    if not needsRewrite(message, histroy):
        return RewriteResult(
            originalQuery=message, rewrittenQuery=message, wasRewritten=False,
        )
    histroy_list = [f'{get_display_role(h.role)}: {h.content}' for h in histroy]
    histroy_text = "\n".join(histroy_list)

    rewritePrompt = f"""你是一个查询改写助手。请根据对话历史，将用户当前的问题改写为一个独立、完整的查询语句。去除代词（如"他"、"这个"、"那些"等），替换为具体的指代内容。
    对话历史：
    {histroy_text}

    用户当前问题：{message}

    请直接输出改写后的查询语句（一行，不要加任何解释）："""

    try:
        content = call_deepseek([ChatMessage(role="user", content=rewritePrompt)])
        rewritten = content.strip()

        # call_deepseek 失败时**不抛异常**，而是返回兜底话术「抱歉，当前服务繁忙…」。
        # 不当心的话它会被当成改写结果一路带下去：
        #   · 检索层拿这句话去查，召回一堆无关文档；
        #   · wasRewritten=True 还会让调用方丢掉原始问题。
        # 宁可放弃改写、退回原问题（这正是下面 except 的正常降级路径）。
        if not rewritten or rewritten == FALLBACK_TEXT:
            raise ValueError("改写返回了空串或兜底文案")

        return RewriteResult(
            originalQuery=message, rewrittenQuery=rewritten, wasRewritten=True,
        )
    except Exception as e:
        logger.error("查询改写失败: %s", e)
        return RewriteResult(
            originalQuery=message, rewrittenQuery=message, wasRewritten=False,
        )
