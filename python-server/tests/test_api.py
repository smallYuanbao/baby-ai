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

    
