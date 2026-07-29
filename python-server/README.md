# Python Server — 育儿 AI 助手主服务

## 虚拟环境

```bash
python3 -m venv .venv
source .venv/bin/activate
uv pip install -r requirements/base.txt
```

## 启动

```bash
cd python-server
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

## Docker 部署

```bash
# 1. 构建镜像（首次约 20-30 分钟，后续有缓存分钟级）
docker compose build

# 2. 启动所有服务（backend + chroma + ollama + reranker）
docker compose up -d

# 3. 首次启动后，往 ChromaDB 灌数据（二选一）
docker compose exec backend python scripts/ingest_balanced.py

# 4. 验证
curl http://127.0.0.1:8002/api/health

# 5. 停止
docker compose down
```

**端口映射：**

| 服务 | 端口 |
|------|:---:|
| Backend | 8002 |
| ChromaDB | 8000 |
| Ollama | 11434 |
| Reranker | 8001 |

**首次启动注意：**
- Ollama 会自动拉取 `bge-m3` 模型（`ollama-init` 容器）
- Reranker 首次需下载 BGE 模型（~2.2GB，有 volume 缓存，后续启动秒级）
- ChromaDB 默认无数据，需运行 `ingest_balanced.py` 灌入

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/chat` | POST | RAG 对话（非流式） |
| `/api/chat/stream` | POST | RAG 对话（SSE 流式） |
| `/api/upload` | POST | 文件上传 |
| `/api/agent/chat` | POST | Agent 单次工具调用 |
| `/api/agent/react` | POST | Agent ReAct 多步循环 |
| `/api/agent/reflect` | POST | Agent ReAct + 反思审查 |
| `/api/agent/multi` | POST | 多 Agent 协作管线 |
| `/api/agent/unified` | POST | 统一 Agent（QR + 意图 + MCP工具 + RAG + 生成 + 审查） |
| `/api/agent/mcp` | POST | MCP 协议工具调用 |

## 项目结构

```
app/
├── main.py                    # FastAPI 入口

├── core/
│   └── config.py              # 环境变量配置

├── models/
│   └── chat.py                # Pydantic 模型

├── services/
│   ├── llm.py                 # DeepSeek client
│   ├── prompt.py              # Prompt 模板
│   ├── tools.py               # 本地工具定义
│   │
│   ├── rag/                   # 检索系统
│   │   ├── embedding.py       # get_embedding（Ollama bge-m3）
│   │   ├── retriever.py       # search_docs + BM25 + hybrid + RRF
│   │   └── reranker.py        # rerank（BGE → DeepSeek → 距离兜底）
│   │
│   ├── agent/                 # Agent 逻辑
│   │   ├── base.py            # agent_chat + react_agent_chat
│   │   ├── unified.py         # unified_agent + check_and_call_tool
│   │   ├── reflection.py      # reflect_and_correct + review_agent
│   │   └── mcp_client.py      # MCPClient
│   │
│   ├── pipeline/              # 预处理管线
│   │   ├── rewrite.py         # Query Rewrite
│   │   ├── intent.py          # 意图路由
│   │   ├── session.py         # 会话管理
│   │   └── chat.py            # _build_messages + execute_rag_pipeline
│   │
│   └── upload/
│       └── service.py         # 文件上传服务
│
├── skills/                    # Agent 技能
│   ├── base.py                # BaseSkill 基类
│   ├── search.py              # SearchSkill（检索）
│   ├── review.py              # ReviewerSkill（审查）
│   └── weather.py             # WeatherSkill（天气）
│
└── scripts/                   # 工具脚本
    ├── test_questions.json    # 评估测试集
    ├── eval_rag.py            # 评估管线
    ├── eval_simaple.py        # LLM-as-Judge 评分
    └── ingest_balanced.py     # 数据灌入
```

## Agent 管线流程（/api/agent/unified）

```
用户消息
  → Query Rewrite（指代消解）
  → 意图路由（7 分类）
  → ┬ MCP 工具调用（天气等，LLM 自主决策，ReAct 多步）
    └ RAG 混合检索（Dense + Sparse → 精排）
  → 合并上下文（工具数据 + 检索文档）
  → LLM 生成初步回答
  → 审查反思（医学准确性检查）
  → 返回 { answer, references, category }
```
