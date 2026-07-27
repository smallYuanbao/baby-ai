from app.models.chat import ChatHistoryEntry

# 内存存储：session_id → 消息列表
_sessions: dict[str, list[ChatHistoryEntry]] = {}

# 最大保留轮数（每轮 = 一条 user + 一条 assistant）
MAX_ROUNDS = 10

def get_history(session_id: str) -> list[ChatHistoryEntry]: 
    """获取指定会话的对话历史"""
    print("--- get_history ---", _sessions)
    return _sessions.get(session_id, [])

def add_message(session_id: str, role: str, content: str) -> None:
    """向指定会话追加一条消息"""

    if session_id not in _sessions:
        _sessions[session_id] = []
    
    entry = ChatHistoryEntry(role = role, content=content)

    _sessions[session_id].append(entry)
    # 超出最大轮数时，裁剪最早的消息
    max_messages = MAX_ROUNDS * 2  # 每轮 = user + assistant

    if len(_sessions[session_id]) > max_messages:
        # 找到 session_id 对应的历史消息列表
        # 切片只保留最新的 max_messages 条消息，删掉前面老旧消息
        # 把裁剪后的短列表重新赋值回原会话，实现消息窗口限制。
        _sessions[session_id] = _sessions[session_id][-max_messages:]

def add_user_message(session_id: str, content: str) -> None:
    """追加用户消息"""
    add_message(session_id, "user", content)

    print(f"--- 存入成功 --- session={session_id}, 当前消息数={len(_sessions[session_id])}")


def add_assitant_message(session_id: str, content: str) -> None:
    """追加 AI 回答"""
    add_message(session_id, "assistant",content)

    print(f"--- 存入成功 --- session={session_id}, 当前消息数={len(_sessions[session_id])}")



