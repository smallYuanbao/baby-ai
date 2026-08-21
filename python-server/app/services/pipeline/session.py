from app.models.chat import ChatHistoryEntry
from app.utils.logger import logger

# 内存存储：会话 key → 消息列表
# key = "user_id:session_id"（加 user 维度做多租户隔离，见 _session_key）
_sessions: dict[str, list[ChatHistoryEntry]] = {}

# 最大保留轮数（每轮 = 一条 user + 一条 assistant）
MAX_ROUNDS = 10


def _session_key(user_id: str, session_id: str) -> str:
    """会话 key = user_id:session_id。

    为什么加 user_id？原来的 key 只有 session_id，两个用户若碰巧用同一个
    session_id（或攻击者猜中他人 session_id），会话历史会串掉、甚至泄露上下文。
    拼上 user_id 后，不同用户天然隔离，这是多租户隔离在「会话」维度的一环。
    """
    return f"{user_id}:{session_id}"


def get_history(user_id: str, session_id: str) -> list[ChatHistoryEntry]:
    """获取指定用户在指定会话的对话历史"""
    logger.debug("--- get_history --- %s", _sessions)
    return _sessions.get(_session_key(user_id, session_id), [])


def add_message(user_id: str, session_id: str, role: str, content: str) -> None:
    """向指定用户的指定会话追加一条消息"""
    key = _session_key(user_id, session_id)

    if key not in _sessions:
        _sessions[key] = []

    entry = ChatHistoryEntry(role=role, content=content)

    _sessions[key].append(entry)
    # 超出最大轮数时，裁剪最早的消息
    max_messages = MAX_ROUNDS * 2  # 每轮 = user + assistant

    if len(_sessions[key]) > max_messages:
        # 切片只保留最新的 max_messages 条消息，删掉前面老旧消息
        _sessions[key] = _sessions[key][-max_messages:]


def add_user_message(user_id: str, session_id: str, content: str) -> None:
    """追加用户消息"""
    add_message(user_id, session_id, "user", content)
    logger.info("--- 存入成功 --- session=%s, 当前消息数=%s", session_id, len(_sessions[_session_key(user_id, session_id)]))


def add_assitant_message(user_id: str, session_id: str, content: str) -> None:
    """追加 AI 回答"""
    add_message(user_id, session_id, "assistant", content)
    logger.info("--- 存入成功 --- session=%s, 当前消息数=%s", session_id, len(_sessions[_session_key(user_id, session_id)]))
