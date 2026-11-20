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

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from app.core.config import SESSION_DB_PATH
from app.models.chat import ChatHistoryEntry
from app.utils.logger import logger

# ---------------------------------------------------------------------------
# 两个上限，别混在一起
# ---------------------------------------------------------------------------
# **存储上限**：一个会话最多保留多少条消息（100 条 ≈ 50 轮）。
# 之前是 10 轮（20 条），用户聊到第 11 轮时最早的对话就被**静默删除**了 ——
# 刷新后会发现会话开头凭空消失，且没有任何提示。50 轮对正常使用足够，
# 同时还能兜住"一个会话无限聊下去"的存储/渲染成本。
MAX_STORED_MESSAGES = 100

# **上下文上限**：每次请求最多把多少条历史喂给 LLM（16 条 = 8 轮）。
# 和存储上限完全解耦：存下来是为了给用户看和恢复，不是全部塞进 prompt。
# 客户端也会自己按 8 轮截断；这里是服务端兜底（客户端不传 history 时生效）。
MAX_CONTEXT_MESSAGES = 16

# 建表 SQL（幂等，_connect 时执行）
_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- 助手消息的引用（JSON 数组，原始 {id,text,score} 结构）。
    -- 不存的话，刷新后恢复出来的回答没有来源，右侧面板会对着一轮真实检索过的
    -- 回答显示"本次没有用到知识库" —— 比不恢复更误导。
    --
    -- 列名不能叫 references：那是 SQLite 的保留字（外键 REFERENCES），
    -- 建表时会直接报 near "references": syntax error。
    refs_json  TEXT
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
    _migrate_references(conn)
    return conn


def _migrate_references(conn: sqlite3.Connection) -> None:
    """给旧库补上 references 列。

    CREATE TABLE IF NOT EXISTS 不会改已存在的表，所以新增列必须单独 ALTER。
    幂等：先查 PRAGMA，已经有了就跳过。
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(messages)")}
    if "refs_json" not in columns:
        conn.execute("ALTER TABLE messages ADD COLUMN refs_json TEXT")
        conn.commit()


def get_history(user_id: str, session_id: str) -> list[ChatHistoryEntry]:
    """获取给 LLM 用的对话历史（最近 MAX_CONTEXT_MESSAGES 条，按写入顺序）。

    注意这里**不返回整个会话**：库里最多保留 MAX_STORED_MESSAGES 条，
    但 prompt 只需要最近几轮。两者混用会把 50 轮全塞进上下文，
    既费 token 又稀释当前问题。
    """
    conn = _connect()
    try:
        # 先按 id 倒序取最近 N 条，再反转为正序（SQLite 不支持 LIMIT + 正序取尾部）
        rows = conn.execute(
            """
            SELECT role, content FROM (
                SELECT id, role, content
                FROM messages
                WHERE user_id = ? AND session_id = ?
                ORDER BY id DESC
                LIMIT ?
            )
            ORDER BY id ASC
            """,
            (user_id, session_id, MAX_CONTEXT_MESSAGES),
        ).fetchall()
        # 跳过 content 为空的历史行:老数据里可能存过空回答(修复前无此校验),
        # 而 ChatHistoryEntry 要求至少 1 个字符——不跳过就会让该会话之后**永远 500**。
        # 读时容错 + 写时拦截,两边都要有:拦的是新数据,容的是已经躺在库里的。
        return [
            ChatHistoryEntry(role=r["role"], content=r["content"])
            for r in rows
            if (r["content"] or "").strip()
        ]
    finally:
        conn.close()


def add_message(
    user_id: str,
    session_id: str,
    role: str,
    content: str,
    references: Optional[list[dict]] = None,
) -> int:
    """向指定用户的指定会话追加一条消息，返回当前消息数。

    `references` 只对助手消息有意义：存的是 SSE 里原样的 `{id,text,score}` 数组，
    由客户端在恢复时再归一化。存原始结构而不是渲染后的字段，是因为「怎么展示」
    属于前端的事（见 client/src/utils/reference.ts）。
    """
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO messages (user_id, session_id, role, content, created_at, refs_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                session_id,
                role,
                content,
                _now(),
                json.dumps(references, ensure_ascii=False) if references else None,
            ),
        )
        # 超出存储上限时，只保留最新的 MAX_STORED_MESSAGES 条，删掉更早的
        max_messages = MAX_STORED_MESSAGES
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


def add_assitant_message(
    user_id: str,
    session_id: str,
    content: str,
    references: Optional[list[dict]] = None,
) -> None:
    """追加 AI 回答。

    **空回答直接丢弃,不落库**:ChatHistoryEntry 要求 content 至少 1 个字符,
    存进空串会让**该会话之后每次取历史都抛 ValidationError → 整个会话 500**。
    一条空回答不该把整个会话废掉。(实测踩过:上游一次空响应导致后续请求全 500。)
    """
    if not (content or "").strip():
        logger.warning("[会话] 回答为空,跳过落库 session=%s", session_id)
        return
    count = add_message(user_id, session_id, "assistant", content, references)
    logger.info("--- 存入成功 --- session=%s, 当前消息数=%s", session_id, count)


def list_sessions(user_id: str) -> list[dict]:
    """列出该用户的会话（按最近活动倒序）。

    返回给前端做「历史会话列表」用的轻量投影：标题取首条用户消息的前 30 字。
    """
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT session_id,
                   COUNT(*)        AS message_count,
                   MAX(created_at) AS updated_at
            FROM messages
            WHERE user_id = ?
            GROUP BY session_id
            ORDER BY updated_at DESC
            """,
            (user_id,),
        ).fetchall()

        sessions = []
        for row in rows:
            first = conn.execute(
                """
                SELECT content FROM messages
                WHERE user_id = ? AND session_id = ? AND role = 'user'
                ORDER BY id ASC LIMIT 1
                """,
                (user_id, row["session_id"]),
            ).fetchone()
            title = (first["content"] if first else "").strip().replace("\n", " ")[:30]
            sessions.append(
                {
                    "sessionId": row["session_id"],
                    "title": title or "新对话",
                    "messageCount": row["message_count"],
                    "updatedAt": row["updated_at"],
                }
            )
        return sessions
    finally:
        conn.close()


def delete_session(user_id: str, session_id: str) -> bool:
    """删除某个会话的全部消息。

    幂等：会话不存在（或已被删掉）也返回 True —— 用户连点两下删除、
    或多端同时删除，都不该看到一个"删除失败"的红字。
    """
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM messages WHERE user_id = ? AND session_id = ?",
            (user_id, session_id),
        )
        conn.commit()
        return True
    finally:
        conn.close()


def get_session_messages(user_id: str, session_id: str) -> list[dict]:
    """读取一个会话的完整消息（按写入顺序）。

    `references` 以原始 JSON 结构返回（前端用 normalizeReferences 归一化）。
    未知会话返回空列表而不是 404 —— 客户端持久化的 sessionId 可能因为清库而失效，
    "没有历史" 比 "接口报错" 更适合这种情况。
    """
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT role, content, created_at, refs_json
            FROM messages
            WHERE user_id = ? AND session_id = ?
            ORDER BY id ASC
            """,
            (user_id, session_id),
        ).fetchall()
        return [
            {
                "role": row["role"],
                "content": row["content"],
                "createdAt": row["created_at"],
                "references": json.loads(row["refs_json"]) if row["refs_json"] else None,
            }
            for row in rows
        ]
    finally:
        conn.close()
