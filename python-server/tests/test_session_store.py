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
    """超过 MAX_ROUNDS*2 条时，只保留最新消息，最早的被删掉"""
    for i in range(session.MAX_ROUNDS * 2 + 3):  # 写入 23 条
        session.add_user_message(USER, "s1", f"消息{i}")

    history = session.get_history(USER, "s1")
    assert len(history) == session.MAX_ROUNDS * 2  # 裁剪到 20 条
    # 最早的消息被删，最新的保留
    assert history[0].content == "消息3"
    assert history[-1].content == f"消息{session.MAX_ROUNDS * 2 + 2}"

    # 落库也只有 20 条
    conn = sqlite3.connect(db)
    cnt = conn.execute(
        "SELECT COUNT(*) FROM messages WHERE user_id = ? AND session_id = ?",
        (USER, "s1"),
    ).fetchone()[0]
    conn.close()
    assert cnt == session.MAX_ROUNDS * 2


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
