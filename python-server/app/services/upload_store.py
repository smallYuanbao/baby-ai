"""上传文件元信息的存储层（SQLite 单文件）。

## 为什么单独存一份

上传时会对文件做一次归类（摘要 + 是否育儿相关），这份结果要在**之后的每一轮对话**
里被意图门控复用 —— 用户上传完文件后打的字往往就是「帮我看看」这种没有信息量的话，
脱离附件判断不了它是不是育儿问题。

放哪儿都不合适，所以单开一张小表：

- 塞进 Chroma 的 chunk metadata？要额外查一次向量库、还得对多个 chunk 去重；
- 让前端随消息带回来？等于信任客户端 —— 门控拿到的判断会变成可被篡改的输入。

按 `file_id` 在服务端查，最直接，也最稳。

## 约定

- 与 `growth_store` / `pipeline.session` 一致：每个操作独立 `_connect()`（新建连接、
  用完即关），避免跨线程共享连接。
- 归类结果允许为空：LLM 挂了、解析不出内容时 `summary=None`、`parenting_related=None`
  （"没判出来"）。**调用方必须把 None 当成"不知道"，不能当成"否"** ——
  把未知当否定会让上传成功的文件被无理由地冷落。
"""

import os
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from app.core.config import UPLOAD_DB_PATH

# parenting_related 用三态整数：1=是 / 0=否 / NULL=没判出来
_SCHEMA = """
CREATE TABLE IF NOT EXISTS uploaded_files (
    file_id            TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL,
    filename           TEXT NOT NULL,
    summary            TEXT,
    parenting_related  INTEGER,
    created_at         TEXT NOT NULL
);
"""


def _now() -> str:
    """当前 UTC 时间的 ISO 字符串（与 growth_store 保持一致）"""
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    """新建 SQLite 连接，并确保 schema 存在（幂等）"""
    parent = os.path.dirname(UPLOAD_DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(UPLOAD_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


def save_file_meta(
    *,
    file_id: str,
    user_id: str,
    filename: str,
    summary: Optional[str] = None,
    parenting_related: Optional[bool] = None,
) -> None:
    """记录一次上传的归类结果。重复 file_id 直接覆盖（同一份文件重新传过）。

    Args:
        file_id:           上传时生成的 ID（uuid 前 8 位）
        user_id:           上传者，用于多租户隔离
        filename:          原始文件名（展示用）
        summary:           一两句话的文件摘要；判不出来时传 None
        parenting_related: 是否与育儿相关；**判不出来时传 None，不要传 False**
    """
    value = None if parenting_related is None else int(parenting_related)
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO uploaded_files (file_id, user_id, filename, summary, parenting_related, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
                summary = excluded.summary,
                parenting_related = excluded.parenting_related
            """,
            (file_id, user_id, filename, summary, value, _now()),
        )
        conn.commit()
    finally:
        conn.close()


def get_file_meta(file_id: str) -> Optional[dict]:
    """按 file_id 取归类结果；没有记录时返回 None。

    Returns:
        `{"file_id", "user_id", "filename", "summary", "parenting_related"}`
        —— `parenting_related` 还原成 `True` / `False` / `None`（三态）。
    """
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT file_id, user_id, filename, summary, parenting_related "
            "FROM uploaded_files WHERE file_id = ?",
            (file_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return None

    raw = row["parenting_related"]
    return {
        "file_id": row["file_id"],
        "user_id": row["user_id"],
        "filename": row["filename"],
        "summary": row["summary"],
        "parenting_related": None if raw is None else bool(raw),
    }
