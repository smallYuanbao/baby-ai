"""growth_store（SQLite 存储层）单元测试

覆盖宝宝档案 + 成长记录的 CRUD、部分更新、外键级联删除、聚合统计，以及
方案 A 的多租户隔离（不同 user_id 看不到彼此数据）。

不依赖 ChromaDB / LLM —— 通过 monkeypatch 把 GROWTH_DB_PATH 指向临时文件。
"""

import pytest

from app.models.growth import (
    CreateChild,
    CreateGrowthRecord,
    Feeding,
    UpdateChild,
    UpdateGrowthRecord,
)
from app.services import growth_store


@pytest.fixture
def db(monkeypatch, tmp_path):
    """把存储路径指到临时 SQLite 文件，每个测试独立、互不污染"""
    db_path = str(tmp_path / "growth.db")
    monkeypatch.setattr(growth_store, "GROWTH_DB_PATH", db_path)
    return db_path


# 方案 A：所有存储操作都需要显式传入 user_id（当前登录用户）
USER = "user_alice"


def _child(name="小明", birth_date="2023-05-10", gender="male") -> CreateChild:
    return CreateChild(name=name, birthDate=birth_date, gender=gender)


def _record(date="2024-01-01", weight=10.5, height=75.0) -> CreateGrowthRecord:
    return CreateGrowthRecord(date=date, weight=weight, height=height)


# ---------------------------------------------------------------
# 宝宝档案 CRUD
# ---------------------------------------------------------------

def test_create_and_get_child(db):
    created = growth_store.create_child(USER, _child())
    assert created.childId.startswith("c_")

    got = growth_store.get_child(USER, created.childId)
    assert got is not None
    assert got.name == "小明"
    assert got.birthDate == "2023-05-10"
    assert got.gender == "male"
    assert got.records == []


def test_get_missing_child_returns_none(db):
    assert growth_store.get_child(USER, "c_nonexistent") is None


def test_list_children_with_stats(db):
    """list_children 返回轻量投影 + 聚合统计（recordCount / lastRecordDate）"""
    c1 = growth_store.create_child(USER, _child(name="大宝"))
    c2 = growth_store.create_child(USER, _child(name="二宝"))

    growth_store.add_record(USER, c1.childId, _record(date="2024-03-01", weight=8.0))
    growth_store.add_record(USER, c1.childId, _record(date="2024-06-01", weight=9.5))

    summaries = growth_store.list_children(USER)
    by_id = {s.childId: s for s in summaries}

    assert by_id[c1.childId].recordCount == 2
    assert by_id[c1.childId].lastRecordDate == "2024-06-01"  # 取最新一条
    assert by_id[c2.childId].recordCount == 0
    assert by_id[c2.childId].lastRecordDate is None

    # 有记录的排前面
    assert summaries[0].childId == c1.childId


def test_update_child_partial(db):
    child = growth_store.create_child(USER, _child())
    updated = growth_store.update_child(USER, child.childId, UpdateChild(name="小名"))
    assert updated.name == "小名"
    # 未传字段保持不变
    assert updated.birthDate == "2023-05-10"
    assert updated.gender == "male"


def test_delete_child_cascades_records(db):
    child = growth_store.create_child(USER, _child())
    growth_store.add_record(USER, child.childId, _record())

    assert growth_store.delete_child(USER, child.childId) is True
    # 档案已删
    assert growth_store.get_child(USER, child.childId) is None
    # 记录应被外键级联删除（直接查 DB 验证）
    import sqlite3
    conn = sqlite3.connect(db)
    cnt = conn.execute(
        "SELECT COUNT(*) FROM records WHERE child_id = ?", (child.childId,)
    ).fetchone()[0]
    conn.close()
    assert cnt == 0


# ---------------------------------------------------------------
# 成长记录 CRUD
# ---------------------------------------------------------------

def test_add_record_with_feeding(db):
    child = growth_store.create_child(USER, _child())
    feeding = Feeding(type="breast", amount=120, unit="ml")
    rec = growth_store.add_record(
        USER,
        child.childId,
        CreateGrowthRecord(date="2024-01-01", weight=10.0, feeding=feeding, diapers=6),
    )
    assert rec.id.startswith("rec_")
    assert rec.feeding.type == "breast"
    assert rec.feeding.amount == 120
    # feeding 是嵌套对象，回读后仍能还原
    got = growth_store.get_child(USER, child.childId)
    assert got.records[0].feeding.unit == "ml"


def test_add_record_to_missing_child(db):
    assert growth_store.add_record(USER, "c_nope", _record()) is None


def test_update_record_partial(db):
    child = growth_store.create_child(USER, _child())
    rec = growth_store.add_record(USER, child.childId, _record(weight=10.0, height=75.0))

    updated = growth_store.update_record(
        USER, child.childId, rec.id, UpdateGrowthRecord(weight=11.0)
    )
    assert updated.weight == 11.0
    assert updated.height == 75.0  # 未传字段保持不变


def test_delete_record(db):
    child = growth_store.create_child(USER, _child())
    rec = growth_store.add_record(USER, child.childId, _record())

    assert growth_store.delete_record(USER, child.childId, rec.id) is True
    assert growth_store.delete_record(USER, child.childId, rec.id) is False  # 二次删除返回 False
    got = growth_store.get_child(USER, child.childId)
    assert got.records == []


# ---------------------------------------------------------------
# 多租户隔离（方案 A）
# ---------------------------------------------------------------

def test_multi_tenant_isolation(db):
    """alice 建的档案，bob 既看不到、也改不了、更删不掉（IDOR 越权防护）"""
    alice_child = growth_store.create_child("user_alice", _child(name="Alice的宝宝"))
    growth_store.add_record("user_alice", alice_child.childId, _record(weight=8.0))

    # 1. bob 的列表里没有 alice 的宝宝
    assert growth_store.list_children("user_bob") == []

    # 2. bob 按 ID 直接取 → None（拿不到他人数据）
    assert growth_store.get_child("user_bob", alice_child.childId) is None

    # 3. bob 尝试更新 / 删除 / 加记录 → 全部 None / False（越权被拦）
    assert growth_store.update_child("user_bob", alice_child.childId, UpdateChild(name="篡改")) is None
    assert growth_store.delete_child("user_bob", alice_child.childId) is False
    assert growth_store.add_record("user_bob", alice_child.childId, _record()) is None

    # 4. alice 自己的数据完好无损
    assert growth_store.get_child("user_alice", alice_child.childId).name == "Alice的宝宝"
