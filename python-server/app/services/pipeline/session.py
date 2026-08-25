"""会话存储层（SQLite 持久化）

## 为什么从「内存 dict」改成 SQLite？

原实现用进程内 `dict` 存会话历史（key = `user_id:session_id`），服务一重启
所有对话就丢。切到 SQLite 后：

  - 持久化：对话历史落盘，服务重启不丢
  - 多租户隔离：user_id + session_id 双列过滤，天然隔离（替代原来的字符串拼接 key）
  - 可审计：每条消息带 created_at，为后续「对话日志审计 / 降冷」留口子（工程化题13）

数据模型（单表）：

```
messages(id INTEGER PK AUTOINCREMENT, user_id, session_id, role, content, created_at)
```

role 只有 user / assistant 两种（见 ChatHistoryEntry 的 Literal 类型）。
id 自增保证消息顺序，裁剪时按 id 保留最新 N 条。

## 并发策略

和 growth_store 一致：每个操作独立 `_connect()`（新建连接、用完即关），
FastAPI 同步端点跑线程池，这种「一操作一连接」模式天然线程安全，代价是
可忽略的连接开销（原型规模足够）。
"""

import os
import sqlite3
from datetime import datetime, timezone

from app.core.config import SESSION_DB_PATH
from app.models.chat import ChatHistoryEntry
from app.utils.logger import logger

# 最大保留轮数（每轮 = 一条 user + 一条 assistant）
MAX_ROUNDS = 10

# 建表 SQL（幂等，_connect 时执行）
_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages (user_id, session_id, id);
"""


def _now() -> str:
    """当前 UTC 时间的 ISO 字符串"""
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    """新建 SQLite 连接，并确保 schema 存在（幂等）"""
    parent = os.path.dirname(SESSION_DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(SESSION_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


def get_history(user_id: str, session_id: str) -> list[ChatHistoryEntry]:
    """获取指定用户在指定会话的对话历史（按写入顺序）"""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT role, content
            FROM messages
            WHERE user_id = ? AND session_id = ?
            ORDER BY id ASC
            """,
            (user_id, session_id),
        ).fetchall()
        return [ChatHistoryEntry(role=r["role"], content=r["content"]) for r in rows]
    finally:
        conn.close()


def add_message(user_id: str, session_id: str, role: str, content: str) -> int:
    """向指定用户的指定会话追加一条消息，返回当前消息数"""
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO messages (user_id, session_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, session_id, role, content, _now()),
        )
        # 超出最大轮数时，只保留最新的 max_messages 条，删掉更早的
        max_messages = MAX_ROUNDS * 2  # 每轮 = user + assistant
        conn.execute(
            """
            DELETE FROM messages
            WHERE user_id = ? AND session_id = ?
              AND id NOT IN (
                  SELECT id FROM messages
                  WHERE user_id = ? AND session_id = ?
                  ORDER BY id DESC LIMIT ?
              )
            """,
            (user_id, session_id, user_id, session_id, max_messages),
        )
        conn.commit()
        count = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE user_id = ? AND session_id = ?",
            (user_id, session_id),
        ).fetchone()[0]
        return count
    finally:
        conn.close()


def add_user_message(user_id: str, session_id: str, content: str) -> None:
    """追加用户消息"""
    count = add_message(user_id, session_id, "user", content)
    logger.info("--- 存入成功 --- session=%s, 当前消息数=%s", session_id, count)


def add_assitant_message(user_id: str, session_id: str, content: str) -> None:
    """追加 AI 回答"""
    count = add_message(user_id, session_id, "assistant", content)
    logger.info("--- 存入成功 --- session=%s, 当前消息数=%s", session_id, count)
