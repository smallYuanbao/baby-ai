from fastapi.testclient import TestClient
from app.main import app


client = TestClient(app)

def test_health_check():
    """测试健康检查接口"""
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "timestamp" in data
    assert "uptime" in data

def test_chat_non_stream():
    """测试非流式聊天接口"""
    response = client.post("/api/chat", json={
        "message": "宝宝发烧怎么办",
        "session_id": "test"
    })
    assert response.status_code == 200
    data = response.json()

    assert "answer" in data
    assert len(data["answer"]) > 0
    assert "references" in data

def test_chat_empty_message():
    """测试空消息应返回 422"""
    response = client.post("/api/chat", json={
        "message": "",
        "session_id": "test"
    })
    assert response.status_code == 422

    


# ---------- 限流分桶 ----------

def _mk_request(auth: str | None = None):
    from starlette.requests import Request
    headers = [(b"authorization", auth.encode())] if auth else []
    return Request({"type": "http", "headers": headers, "client": ("127.0.0.1", 1234),
                    "method": "POST", "path": "/api/chat"})


def test_rate_limit_key_is_per_user_not_per_ip():
    """限流按「用户」分桶,不按 IP。

    按 IP 会误伤:公司/学校 NAT 后的多个用户共用一个出口 IP、互相抢额度;
    本地开发时全是 127.0.0.1,整台机器共用一个桶。
    """
    from app.main import _rate_limit_key
    alice = _rate_limit_key(_mk_request("Bearer dev-key-alice"))
    bob = _rate_limit_key(_mk_request("Bearer dev-key-bob"))

    assert alice == "user_alice"
    assert bob == "user_bob"
    # 同一台机器(同 IP)的两个用户必须落在不同桶里——这正是本次修复的点
    assert alice != bob


def test_rate_limit_key_falls_back_to_ip_for_anonymous():
    """匿名请求按 IP 兜底:否则所有匿名用户挤一个桶,一个人刷就把别人挡了。"""
    from app.main import _rate_limit_key
    key = _rate_limit_key(_mk_request())
    assert key.startswith("ip:")
