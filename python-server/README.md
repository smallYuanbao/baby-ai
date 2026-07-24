# Python Server — 育儿 AI 助手主服务

## 虚拟环境

```bash
# 创建（仅第一次）
python3 -m venv .venv

# 激活
source .venv/bin/activate

# 安装依赖
uv pip install -r requirements/base.txt
```

## 启动

```bash
cd python-server
source .venv/bin/activate
uvicorn app.main:app --reload --port 8002
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/chat` | POST | 对话（非流式） |
| `/api/chat/stream` | POST | 对话（SSE 流式） |
| `/api/upload` | POST | 文件上传 |
| `/api/agent` | POST | Agent 对话（ReAct） |
