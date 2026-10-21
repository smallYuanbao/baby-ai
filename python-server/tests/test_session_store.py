"""session 存储层（SQLite 持久化）单元测试

覆盖对话历史的增查、顺序保持、超长裁剪，以及多租户隔离（同一 session_id
下不同 user 各自独立）。

不依赖 ChromaDB / LLM —— 通过 monkeypatch 把 SESSION_DB_PATH 指向临时文件。
"""

import sqlite3

import pytest

from app.services.pipeline import session


@pytest.fixture
def db(monkeypatch, tmp_path):
    """把存储路径指到临时 SQLite 文件，每个测试独立、互不污染"""
    db_path = str(tmp_path / "sessions.db")
    monkeypatch.setattr(session, "SESSION_DB_PATH", db_path)
    return db_path


USER = "user_alice"


def test_empty_history(db):
    assert session.get_history(USER, "s_nonexistent") == []


def test_add_and_get_history(db):
    session.add_user_message(USER, "s1", "宝宝发烧了怎么办")
    session.add_assitant_message(USER, "s1", "先物理降温，超过38.5度就医")

    history = session.get_history(USER, "s1")
    assert [m.role for m in history] == ["user", "assistant"]
    assert history[0].content == "宝宝发烧了怎么办"
    assert history[1].content == "先物理降温，超过38.5度就医"


def test_history_is_persistent_across_connections(db):
    """每次调用都是独立连接，写入后新连接仍能读到（等价于服务重启不丢）"""
    session.add_user_message(USER, "s1", "第一轮提问")
    session.add_assitant_message(USER, "s1", "第一轮回答")

    # 重新读取（新连接），数据仍在
    history = session.get_history(USER, "s1")
    assert len(history) == 2


def test_trim_old_messages(db):
    """超过存储上限时只保留最新消息，最早的被删掉"""
    total = session.MAX_STORED_MESSAGES + 5
    for i in range(total):
        session.add_user_message(USER, "s1", f"消息{i}")

    stored = session.get_session_messages(USER, "s1")
    assert len(stored) == session.MAX_STORED_MESSAGES
    # 最早的消息被删，最新的保留
    assert stored[0]["content"] == "消息5"
    assert stored[-1]["content"] == f"消息{total - 1}"


def test_llm_history_is_windowed_separately_from_storage(db):
    """存储保留 100 条，但喂给 LLM 的只有最近 16 条 —— 两个上限是独立的。"""
    for i in range(session.MAX_STORED_MESSAGES):
        session.add_user_message(USER, "s1", f"消息{i}")

    history = session.get_history(USER, "s1")

    assert len(history) == session.MAX_CONTEXT_MESSAGES
    assert history[0].content == f"消息{session.MAX_STORED_MESSAGES - session.MAX_CONTEXT_MESSAGES}"
    assert history[-1].content == f"消息{session.MAX_STORED_MESSAGES - 1}"

    # 落库仍是完整的 MAX_STORED_MESSAGES 条（上下文窗口不影响存储）
    conn = sqlite3.connect(db)
    cnt = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE user_id = ? AND session_id = ?",
        (USER, "s1"),
    ).fetchone()[0]
    conn.close()
    assert cnt == session.MAX_STORED_MESSAGES


def test_multi_tenant_isolation(db):
    """同一 session_id 下，不同 user 的对话各自独立（防会话串号/越权）"""
    session.add_user_message("user_alice", "s1", "alice 的问题")
    session.add_user_message("user_bob", "s1", "bob 的问题")

    alice_history = session.get_history("user_alice", "s1")
    bob_history = session.get_history("user_bob", "s1")

    assert [m.content for m in alice_history] == ["alice 的问题"]
    assert [m.content for m in bob_history] == ["bob 的问题"]
    # bob 拿不到 alice 的消息
    assert all("alice" not in m.content for m in bob_history)


# —— 空回答不得污染会话(实测:一次空响应能让会话后续请求全 500) ——

def test_empty_assistant_message_is_not_stored(db):
    """空回答不落库。ChatHistoryEntry 要求 content≥1 字符,存进去会让该会话之后永远 500。"""
    session.add_assitant_message("u_empty", "s_empty", "")
    session.add_assitant_message("u_empty", "s_empty", "   ")
    assert session.get_history("u_empty", "s_empty") == []

    session.add_assitant_message("u_empty", "s_empty", "正常回答")
    assert len(session.get_history("u_empty", "s_empty")) == 1


def test_get_history_tolerates_already_poisoned_rows(db):
    """读时容错:修复前已经写进库的空行,不能让该会话继续 500。"""
    session.add_message("u_poison", "s_poison", "assistant", "")   # 绕过写时校验,模拟老数据
    session.add_message("u_poison", "s_poison", "user", "你好")
    hist = session.get_history("u_poison", "s_poison")             # 不抛 ValidationError
    assert [h.content for h in hist] == ["你好"]


# ===============================================================
# 会话列表 / 会话恢复（refresh 后恢复对话）
# ===============================================================

def test_list_sessions_ordered_by_recent_activity(db):
    session.add_user_message(USER, "s_old", "先问的")
    session.add_assitant_message(USER, "s_old", "先答的")
    session.add_user_message(USER, "s_new", "后问的")

    sessions = session.list_sessions(USER)
    assert [s["sessionId"] for s in sessions] == ["s_new", "s_old"]

    old = next(s for s in sessions if s["sessionId"] == "s_old")
    assert old["messageCount"] == 2
    assert old["title"] == "先问的"


def test_list_sessions_is_user_scoped(db):
    session.add_user_message("user_bob", "s_bob", "bob 的问题")
    assert session.list_sessions(USER) == []


def test_get_session_messages_restores_answers_and_references(db):
    refs = [{"id": "med_1", "text": "宝宝发烧护理指南", "score": 0.94}]
    session.add_user_message(USER, "s1", "宝宝发烧怎么处理？")
    session.add_assitant_message(USER, "s1", "先物理降温", refs)

    messages = session.get_session_messages(USER, "s1")

    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[1]["content"] == "先物理降温"
    # 引用以原始结构返回，交给前端 normalizeReferences 归一化
    assert messages[1]["references"] == refs
    # 用户消息没有引用
    assert messages[0]["references"] is None


def test_get_session_messages_unknown_session_is_empty(db):
    assert session.get_session_messages(USER, "s_unknown") == []
