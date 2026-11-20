"""成长记录接口的输入约束。

背景：`CreateGrowthRecord` 除 `date` 外所有字段都是可选的，于是「什么都不填」
也能通过校验，存下一条只有日期的空记录。这种记录会占列表一行、让「共 N 条
记录」虚高，却不会产生任何图表数据点 —— 对用户没有任何价值。

前端已经禁用了空表单的保存按钮，这里钉住服务端那道防线：接口是公开的，
脚本或旧版本客户端不该能把空记录写进来。
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import growth_store

AUTH = {"Authorization": "Bearer dev-key-alice"}


@pytest.fixture
def api(monkeypatch, tmp_path):
    """每个测试用独立的临时 SQLite，互不污染。"""
    monkeypatch.setattr(growth_store, "GROWTH_DB_PATH", str(tmp_path / "growth.db"))
    return TestClient(app)


@pytest.fixture
def child_id(api):
    res = api.post(
        "/api/growth/children",
        json={"name": "小明", "birthDate": "2024-01-01", "gender": "male"},
        headers=AUTH,
    )
    assert res.status_code == 201
    return res.json()["childId"]


def _add_record(api, child_id, body):
    return api.post(f"/api/growth/children/{child_id}/records", json=body, headers=AUTH)


def test_record_with_only_a_date_is_rejected(api, child_id):
    res = _add_record(api, child_id, {"date": "2026-10-17"})

    assert res.status_code == 400
    body = res.json()
    assert body["code"] == "EMPTY_RECORD"
    assert "至少填写一项" in body["error"], "错误信息要告诉用户该填什么，而不是只说失败"


def test_notes_alone_is_a_valid_record(api, child_id):
    """备注本身就是有效内容（"今天会翻身了"）。"""
    res = _add_record(api, child_id, {"date": "2026-10-17", "notes": "今天会翻身了"})
    assert res.status_code == 201


def test_feeding_without_amount_is_not_content(api, child_id):
    """表单默认会带 type/unit，光有喂养类型和单位不算填了内容。"""
    res = _add_record(
        api,
        child_id,
        {"date": "2026-10-17", "feeding": {"type": "breast", "unit": "ml"}},
    )
    assert res.status_code == 400


def test_metric_alone_is_valid(api, child_id):
    res = _add_record(api, child_id, {"date": "2026-10-17", "height": 70})
    assert res.status_code == 201

    body = res.json()
    assert body["height"] == 70
    # 未填字段返回 null —— 前端渲染时必须用 `!= null` 判断，
    # 只判 `!== undefined` 会渲染出没有数字的「🧷 次」。
    assert body["diapers"] is None
