"""
成长记录存储层（SQLite）

## 为什么用 SQLite 而非原 Express 的 JSON 文件方案？

原 TS 后端每个宝宝一个 JSON 文件（`server/data/growth/*.json`），读改写整文件、
无跨请求锁、并发下会丢更新。切到 Python 后端时换成 SQLite：

  - 事务原子性：CRUD 不会出现「读一半 / 写一半」
  - 外键级联：删宝宝自动删其所有记录（ON DELETE CASCADE）
  - 关系查询：`record_count` / `last_record_date` 用聚合一次算好，不用读全部文件
  - 零部署依赖：`sqlite3` 是标准库，无需额外装数据库

## 数据模型（两表，一对多）

```
children(child_id PK, name, birth_date, gender, created_at, updated_at)
    └── records(id PK, child_id FK, date, height, weight, head_circumference,
                sleep_duration, feeding JSON, diapers, notes, created_at)
```

feeding 是嵌套对象，用 JSON 字符串存 TEXT 列，读写时序列化/反序列化。

## 并发策略

每个操作独立 `_connect()`（新建连接、用完即关），避免跨线程共享同一个
`sqlite3.Connection` 导致的 `check_same_thread` 报错。FastAPI 的同步端点跑在
线程池里，这种「一操作一连接」的模式天然线程安全，代价是可忽略的连接开销
（原型规模足够）。
"""

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Optional

from app.core.config import GROWTH_DB_PATH
from app.models.growth import (
    Child,
    ChildSummary,
    CreateChild,
    CreateGrowthRecord,
    GrowthRecord,
    UpdateChild,
    UpdateGrowthRecord,
)

# 建表 SQL（幂等，_connect 时执行）
_SCHEMA = """
CREATE TABLE IF NOT EXISTS children (
    child_id   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    gender     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
    id               TEXT PRIMARY KEY,
    child_id         TEXT NOT NULL,
    date             TEXT NOT NULL,
    height           REAL,
    weight           REAL,
    head_circumference REAL,
    sleep_duration   REAL,
    feeding          TEXT,
    diapers          INTEGER,
    notes            TEXT,
    created_at       TEXT NOT NULL,
    FOREIGN KEY (child_id) REFERENCES children (child_id) ON DELETE CASCADE
);
"""


def _now() -> str:
    """当前 UTC 时间的 ISO 字符串（对齐前端 new Date().toISOString()）"""
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    """新建 SQLite 连接，并确保 schema 存在（幂等）+ 轻量迁移"""
    parent = os.path.dirname(GROWTH_DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(GROWTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")  # 启用外键级联删除
    conn.executescript(_SCHEMA)
    _migrate_user_id(conn)
    return conn


def _migrate_user_id(conn: sqlite3.Connection) -> None:
    """给旧库的 children 表补 user_id 列（幂等迁移）。

    CREATE TABLE IF NOT EXISTS 对已存在的表不会加新列，所以旧库（建表时
    还没有 user_id）需要单独 ALTER。存量数据统一归到匿名用户，避免数据丢失；
    新写入的数据才会带上真实 user_id。
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(children)").fetchall()}
    if "user_id" not in cols:
        conn.execute(
            "ALTER TABLE children ADD COLUMN user_id TEXT NOT NULL DEFAULT 'user_anonymous'"
        )
        conn.commit()


# ---------------------------------------------------------------
# 行 → Pydantic 模型 辅助函数
# ---------------------------------------------------------------

def _row_to_record(row: sqlite3.Row) -> GrowthRecord:
    feeding = json.loads(row["feeding"]) if row["feeding"] else None
    return GrowthRecord(
        id=row["id"],
        date=row["date"],
        height=row["height"],
        weight=row["weight"],
        headCircumference=row["head_circumference"],
        sleepDuration=row["sleep_duration"],
        feeding=feeding,
        diapers=row["diapers"],
        notes=row["notes"],
        createdAt=row["created_at"],
    )


def _row_to_child(row: sqlite3.Row, records: list[GrowthRecord]) -> Child:
    return Child(
        childId=row["child_id"],
        name=row["name"],
        birthDate=row["birth_date"],
        gender=row["gender"],
        records=records,
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _fetch_child_records(conn: sqlite3.Connection, child_id: str) -> list[GrowthRecord]:
    rows = conn.execute(
        "SELECT * FROM records WHERE child_id = ? ORDER BY date DESC", (child_id,)
    ).fetchall()
    return [_row_to_record(r) for r in rows]


# ===============================================================
# 宝宝档案 CRUD
# ===============================================================

def list_children(user_id: str) -> list[ChildSummary]:
    """列出当前用户的所有宝宝（轻量投影，按最近记录日期降序）"""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT * FROM children WHERE user_id = ?", (user_id,)
        ).fetchall()
        summaries = []
        for row in rows:
            # 聚合统计：记录数 + 最近记录日期（无需读出全部记录）
            stat = conn.execute(
                "SELECT COUNT(*) AS cnt, MAX(date) AS last_date FROM records WHERE child_id = ?",
                (row["child_id"],),
            ).fetchone()
            summaries.append(
                ChildSummary(
                    childId=row["child_id"],
                    name=row["name"],
                    birthDate=row["birth_date"],
                    gender=row["gender"],
                    recordCount=stat["cnt"],
                    lastRecordDate=stat["last_date"],
                )
            )
        # 最近有记录的宝宝排前面；无记录（lastRecordDate 为 None）排最后
        summaries.sort(key=lambda s: s.lastRecordDate or "", reverse=True)
        return summaries
    finally:
        conn.close()


def get_child(user_id: str, child_id: str) -> Optional[Child]:
    """按 ID 取单个宝宝（含全部记录），仅限当前用户所有"""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM children WHERE child_id = ? AND user_id = ?",
            (child_id, user_id),
        ).fetchone()
        if row is None:
            return None
        return _row_to_child(row, _fetch_child_records(conn, child_id))
    finally:
        conn.close()


def create_child(user_id: str, data: CreateChild) -> Child:
    """新建宝宝档案（空记录），归属当前用户"""
    conn = _connect()
    try:
        now = _now()
        child_id = f"c_{uuid.uuid4().hex[:8]}"
        conn.execute(
            "INSERT INTO children (child_id, user_id, name, birth_date, gender, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (child_id, user_id, data.name, data.birthDate, data.gender, now, now),
        )
        conn.commit()
        return Child(
            childId=child_id,
            name=data.name,
            birthDate=data.birthDate,
            gender=data.gender,
            records=[],
            createdAt=now,
            updatedAt=now,
        )
    finally:
        conn.close()


def update_child(user_id: str, child_id: str, data: UpdateChild) -> Optional[Child]:
    """部分更新宝宝档案（只更新传入字段），仅限当前用户所有"""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM children WHERE child_id = ? AND user_id = ?",
            (child_id, user_id),
        ).fetchone()
        if row is None:
            return None

        updates: dict[str, str] = {"updated_at": _now()}
        if data.name is not None:
            updates["name"] = data.name
        if data.birthDate is not None:
            updates["birth_date"] = data.birthDate
        if data.gender is not None:
            updates["gender"] = data.gender

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [child_id, user_id]
        conn.execute(f"UPDATE children SET {set_clause} WHERE child_id = ? AND user_id = ?", values)
        conn.commit()

        row = conn.execute(
            "SELECT * FROM children WHERE child_id = ? AND user_id = ?",
            (child_id, user_id),
        ).fetchone()
        return _row_to_child(row, _fetch_child_records(conn, child_id))
    finally:
        conn.close()


def delete_child(user_id: str, child_id: str) -> bool:
    """删除宝宝（级联删除其所有记录），仅限当前用户所有"""
    conn = _connect()
    try:
        cur = conn.execute(
            "DELETE FROM children WHERE child_id = ? AND user_id = ?",
            (child_id, user_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ===============================================================
# 成长记录 CRUD
# ===============================================================

def add_record(user_id: str, child_id: str, data: CreateGrowthRecord) -> Optional[GrowthRecord]:
    """给指定宝宝新增一条成长记录（宝宝必须属于当前用户）"""
    conn = _connect()
    try:
        exists = conn.execute(
            "SELECT child_id FROM children WHERE child_id = ? AND user_id = ?",
            (child_id, user_id),
        ).fetchone()
        if exists is None:
            return None

        record_id = f"rec_{uuid.uuid4().hex[:8]}"
        now = _now()
        feeding_json = json.dumps(data.feeding.model_dump(), ensure_ascii=False) if data.feeding else None
        conn.execute(
            "INSERT INTO records "
            "(id, child_id, date, height, weight, head_circumference, sleep_duration, "
            " feeding, diapers, notes, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                record_id, child_id, data.date, data.height, data.weight,
                data.headCircumference, data.sleepDuration, feeding_json,
                data.diapers, data.notes, now,
            ),
        )
        conn.commit()
        return GrowthRecord(
            id=record_id,
            date=data.date,
            height=data.height,
            weight=data.weight,
            headCircumference=data.headCircumference,
            sleepDuration=data.sleepDuration,
            feeding=data.feeding,
            diapers=data.diapers,
            notes=data.notes,
            createdAt=now,
        )
    finally:
        conn.close()


# 驼峰字段名 → SQLite 蛇形列名
_RECORD_COLUMN_MAP = {
    "date": "date",
    "height": "height",
    "weight": "weight",
    "headCircumference": "head_circumference",
    "sleepDuration": "sleep_duration",
    "feeding": "feeding",
    "diapers": "diapers",
    "notes": "notes",
}


def update_record(
    user_id: str, child_id: str, record_id: str, data: UpdateGrowthRecord
) -> Optional[GrowthRecord]:
    """部分更新成长记录（只更新显式传入的字段），记录必须属于当前用户的宝宝"""
    conn = _connect()
    try:
        # JOIN children 校验归属：记录本身没有 user_id 列，靠 child 的 user_id 隔离
        exists = conn.execute(
            "SELECT r.id FROM records r "
            "JOIN children c ON r.child_id = c.child_id "
            "WHERE r.id = ? AND r.child_id = ? AND c.user_id = ?",
            (record_id, child_id, user_id),
        ).fetchone()
        if exists is None:
            return None

        # exclude_unset=True：只取用户真正传了的字段（区分「没传」和「传 None」）
        set_fields = data.model_dump(exclude_unset=True)
        if not set_fields:
            row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
            return _row_to_record(row)

        updates: dict[str, str] = {}
        values: list = []
        for key, val in set_fields.items():
            col = _RECORD_COLUMN_MAP[key]
            updates[col] = "?"
            if key == "feeding":
                values.append(json.dumps(val.model_dump(), ensure_ascii=False) if val else None)
            else:
                values.append(val)

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values.append(record_id)
        conn.execute(f"UPDATE records SET {set_clause} WHERE id = ?", values)
        conn.commit()

        row = conn.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
        return _row_to_record(row)
    finally:
        conn.close()


def delete_record(user_id: str, child_id: str, record_id: str) -> bool:
    """删除指定记录（记录必须属于当前用户的宝宝）"""
    conn = _connect()
    try:
        # 子查询限定 child_id 必须属于当前用户，防止越权删除他人记录
        cur = conn.execute(
            "DELETE FROM records WHERE id = ? AND child_id IN ("
            "  SELECT child_id FROM children WHERE child_id = ? AND user_id = ?"
            ")",
            (record_id, child_id, user_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
