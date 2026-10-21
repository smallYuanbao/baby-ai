"""会话历史接口。

前端把 sessionId 存在 localStorage，刷新后靠这两个接口恢复对话：
  - GET /api/sessions            会话列表
  - GET /api/sessions/{id}       某个会话的完整消息（含助手引用）

写入路径不在这里测（由聊天管道负责落库），这里只钉住读取契约。
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.pipeline import session

AUTH = {"Authorization": "Bearer dev-key-alice"}
USER = "user_alice"


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setattr(session, "SESSION_DB_PATH", str(tmp_path / "sessions.db"))
    return TestClient(app)


def test_session_list_and_detail(api):
    refs = [{"id": "med_1", "text": "宝宝发烧护理指南", "score": 0.94}]
    session.add_user_message(USER, "s1", "宝宝发烧怎么处理？")
    session.add_assitant_message(USER, "s1", "先物理降温，超过 38.5 度就医", refs)

    res = api.get("/api/sessions", headers=AUTH)
    assert res.status_code == 200
    sessions = res.json()
    assert len(sessions) == 1
    assert sessions[0]["sessionId"] == "s1"
    assert sessions[0]["messageCount"] == 2
    assert sessions[0]["title"] == "宝宝发烧怎么处理？"

    detail = api.get("/api/sessions/s1", headers=AUTH)
    assert detail.status_code == 200
    messages = detail.json()["messages"]

    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[1]["content"] == "先物理降温，超过 38.5 度就医"
    # 引用必须一起回来，否则恢复出来的回答在右侧面板里会显示成"没有用到知识库"
    assert messages[1]["references"] == refs
    assert messages[0]["references"] is None


def test_unknown_session_returns_empty_list_not_404(api):
    """localStorage 里的 sessionId 可能已经失效，应表现为"没有历史"，而不是红字报错。"""
    res = api.get("/api/sessions/s_missing", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {"sessionId": "s_missing", "messages": []}


def test_sessions_are_user_scoped(api):
    session.add_user_message("user_bob", "s_bob", "bob 的问题")
    assert api.get("/api/sessions", headers=AUTH).json() == []


def test_delete_session(api):
    session.add_user_message(USER, "s1", "要删掉的问题")
    session.add_assitant_message(USER, "s1", "要删掉的回答")

    res = api.delete("/api/sessions/s1", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {"success": True}

    assert session.get_session_messages(USER, "s1") == []
    assert api.get("/api/sessions", headers=AUTH).json() == []


def test_delete_is_idempotent_and_user_scoped(api):
    """删别人的会话无效；重复删除不报错。"""
    session.add_user_message("user_bob", "s_bob", "bob 的问题")

    # alice 删除 bob 的 session_id：接口成功，但 bob 的数据不动
    assert api.delete("/api/sessions/s_bob", headers=AUTH).status_code == 200
    assert len(session.get_session_messages("user_bob", "s_bob")) == 1

    # 重复删除 / 删不存在：仍然是 200
    assert api.delete("/api/sessions/s_not_exist", headers=AUTH).status_code == 200
