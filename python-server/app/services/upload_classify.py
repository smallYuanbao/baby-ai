"""上传文件的归类：一句话摘要 + 是否与育儿相关。

## 这一步解决什么

用户上传完文件后打的第一句话往往没有信息量 ——「帮我看看」「这份文件呢」。
脱离附件看，它确实"与育儿无关"，意图门控只能把它判成 off_topic，于是连文件都不读。

所以在上传时就给文件做一次归类，把结果存下来，之后每一轮对话的门控都能拿来
判断「问题 + 这份文件，合起来是不是育儿问题」。

## 为什么放在上传时

- **成本一次性**：一份文件只判一次，而不是每轮对话判一次；
- 上传时本来就已经解析出全文了，不用为了分类再把文件读一遍；
- 还能顺手把结论回给前端，在用户提问**之前**就给出提示。

## 降级约定

任何失败（LLM 挂了、返回不是 JSON、文件内容为空）都返回
`summary=None, parenting_related=None`，**绝不让上传失败** —— 分类只是增强，
不是上传的必要条件。调用方必须把 None 当成"不知道"，不能当成"否"。
"""

import json
from typing import Optional

from app.models.chat import ChatMessage, ChatOptions
from app.services.llm import SHORT_TASK_MAX_TOKENS, call_deepseek
from app.utils.logger import logger

# 只取前这么多字符去判断。摘要不需要读完全文 —— 一份体检报告的开头就足以看出
# 它是不是育儿资料；而长文档全文塞进去既慢又费 token。
_MAX_CHARS_FOR_CLASSIFY = 2000

_CLASSIFY_PROMPT = """你在为一个 **0-6 岁育儿助手** 做文件归类。请阅读下面这份文件的片段，输出 JSON：

{{"summary": "一句话说明这是什么文件（不超过 40 字）", "parenting_related": true/false}}

判断 parenting_related 的标准：
- true —— 内容与婴幼儿养育、健康、喂养、睡眠、发育、疫苗、就医记录等相关。
  包括：体检报告、化验单、疫苗本、生长曲线、育儿文章、保险合同里涉及宝宝医疗保障的部分等。
- false —— 与育儿无关。例如：个人简历、前端代码、与宝宝无关的法律/财务文件、小说。
- **拿不准就判 true** —— 把育儿资料误判成无关，会让家长的提问被无理由冷落；
  反过来，误判成相关最多只是多答一次。

只输出 JSON，不要任何解释。

文件名：{filename}

文件片段：
{excerpt}
"""


def _extract_json(raw: str) -> Optional[dict]:
    """从模型输出里抠出 JSON 对象。

    模型偶尔会裹一层 ```json 或前后加解释文字，这里宽松处理：
    找第一个 `{` 到最后一个 `}`，再解析。解析不出来就返回 None（走降级）。
    """
    if not raw:
        return None
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, ValueError):
        return None


def classify_uploaded_file(
    text: str,
    filename: str,
) -> tuple[Optional[str], Optional[bool]]:
    """对刚上传的文件做一次归类。

    Args:
        text:     解析 + 清洗后的全文（只会取前 2000 字）
        filename: 原始文件名（给模型一点上下文线索）

    Returns:
        `(summary, parenting_related)`
        - 成功：`("一份宝宝体检报告…", True)`
        - 失败/内容为空：`(None, None)` —— 调用方按"不知道"处理，不是"否"
    """
    excerpt = (text or "").strip()[:_MAX_CHARS_FOR_CLASSIFY]
    if not excerpt:
        logger.info("[文件归类] 正文为空，跳过归类：%s", filename)
        return None, None

    try:
        messages = [
            ChatMessage(
                role="user",
                content=_CLASSIFY_PROMPT.format(filename=filename, excerpt=excerpt),
            )
        ]
        # temperature=0 求确定性；预算用 SHORT_TASK_MAX_TOKENS —— 推理模型的思维链
        # 和正文共用这个额度，定小了会**静默**拿到空回答（见 llm.py 的说明）。
        raw = call_deepseek(messages, ChatOptions(temperature=0, maxTokens=SHORT_TASK_MAX_TOKENS))
        parsed = _extract_json(raw)
        if parsed is None:
            logger.warning("[文件归类] 模型输出解析不出 JSON，按未知处理：%s", filename)
            return None, None

        summary = parsed.get("summary")
        summary = summary.strip()[:80] if isinstance(summary, str) and summary.strip() else None

        related = parsed.get("parenting_related")
        # 只接受真正的布尔值。模型可能回 "true" / "是" 之类，那属于没按格式来 ——
        # 与其猜，不如记成"不知道"，下游走的是"不拦也不特殊照顾"的中间路径。
        parenting_related = related if isinstance(related, bool) else None

        logger.info("[文件归类] %s -> related=%s summary=%s", filename, parenting_related, summary)
        return summary, parenting_related

    except Exception as e:
        # 归类失败绝不能让上传失败 —— 它只是增强，不是必要条件。
        logger.warning("[文件归类] 失败（按未知处理）：%s: %s", type(e).__name__, e)
        return None, None


def format_file_context(meta: Optional[dict]) -> Optional[str]:
    """把存储里的归类结果拼成给意图门控看的一小段文字。

    只有真的知道点什么时才返回内容 —— 全是 None 时返回 None，
    让门控走它原来的逻辑，而不是拿到一段"我不知道"的废话。
    """
    if not meta:
        return None

    summary = meta.get("summary")
    related = meta.get("parenting_related")
    if not summary and related is None:
        return None

    parts = [f"用户附上了一份文件：{meta.get('filename') or '(未命名)'}"]
    if summary:
        parts.append(f"文件内容：{summary}")
    if related is True:
        parts.append("判断：与育儿相关")
    elif related is False:
        parts.append("判断：与育儿无关")
    return "；".join(parts)

