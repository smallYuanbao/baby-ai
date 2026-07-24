# BGE Reranker — 精排服务

## 虚拟环境

```bash
# 创建（仅第一次）
python3 -m venv venv

# 激活
source venv/bin/activate

# 安装依赖
uv pip install -r requirements.txt
```

## 启动

```bash
cd reranker
source venv/bin/activate
uvicorn server:app --host 0.0.0.0 --port 8001
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 + 模型加载状态 |
| `/rerank` | POST | 精排打分 |

## 预热

首次启动后建议先预热，避免第一个用户踩冷启动：

```bash
curl -X POST http://127.0.0.1:8001/rerank \
  -H "Content-Type: application/json" \
  -d '{"query": "预热", "documents": [{"id":"0","text":"预热"}], "top_k": 1}'
```
