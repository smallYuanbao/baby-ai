# 🐻 育儿AI助手 - Baby AI

基于 RAG + 意图路由的育儿知识 AI 聊天应用，具备多轮记忆和降级策略，用科学知识和温暖陪伴帮助父母解答育儿问题。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/react-18-61dafb.svg?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178c6.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Less](https://img.shields.io/badge/less-CSS%20Modules-1d365d.svg?logo=less)](https://lesscss.org/)
[![Python](https://img.shields.io/badge/python-3.x-3776ab.svg?logo=python)](https://www.python.org/)
[![Docker](https://img.shields.io/badge/docker-infra-2496ed.svg?logo=docker)](https://www.docker.com/)
[![DeepSeek](https://img.shields.io/badge/AI-DeepSeek-536dfe.svg)](https://platform.deepseek.com/)

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + Less（\*.module.less） |
| 后端 (Node) | Express.js + TypeScript |
| 后端 (Python) | FastAPI + Python 3.12 |
| AI | DeepSeek API（流式 SSE） |
| Agent | ReAct 循环 + MCP 工具调用 |
| 嵌入 | Ollama + bge-m3 |
| 向量库 | ChromaDB |
| RAG管道 | 查询改写 → 意图路由 → 混合检索(Dense+Sparse) → 重排序 → 生成 |

## 功能特性

- 💬 **智能育儿问答**：科学的育儿知识回答，覆盖喂养、睡眠、发育、疾病护理等
- 📚 **RAG 检索增强**：基于知识库的精准回答，附带引用来源和相关性分数
- ⚡ **SSE 流式输出**：实时打字效果，Token 批处理 + React.memo + 流式期纯文本渲染，避免逐 token 重渲染和 Markdown 重复解析
- 🔄 **多轮对话**：支持指代消解（自动识别"他/这个/那些"等代词）和意图路由
- 🛡️ **降级策略**：检索不足时自动降级为通用回答
- 📁 **文件上传**：支持 PDF、TXT、图片上传
- 🎨 **儿童友好UI**：暖橙配色、大圆角、可爱小熊形象

## 🐍 Python 后端（推荐）

Python 版是 Express 版的完整重构，增加了意图路由、混合检索(RRF + 线性加权)、精排降级、Agent 工具调用、MCP 协议支持，并提供评估和基准测试工具链。

### 快速开始

```bash
cd python-server
source .venv/bin/activate
uvicorn app.main:app --reload --port 8000
```

详见 [python-server/README.md](python-server/README.md)

### 新增功能（vs Express 版）

| 功能 | 说明 |
|------|------|
| 🧭 意图路由 | keyword + LLM 双层分诊，7 类意图自动识别 |
| 🔀 混合检索 | RRF 排名融合 + 线性加权，Dense(语义) + Sparse(关键词) |
| 🎯 精排降级 | BGE Reranker → DeepSeek → 距离兜底，三级容错 |
| 🤖 Agent | ReAct 决策循环 + function calling 工具调用 |
| 🔌 MCP | Model Context Protocol 客户端，连接远程工具服务 |
| 📊 评估工具 | LLM-as-Judge 打分 + faithfulness/relevancy/recall 三维度 |
| ⚡ 基准测试 | ANN vs 暴力搜索对比、维度对比实验 |
| 📁 文件上传 | PDF/TXT 解析 → 语义分块 → 向量化入库 |

### Agent 端点

| 端点 | 说明 |
|------|------|
| `POST /api/agent/chat` | 单次工具调用 |
| `POST /api/agent/react` | ReAct 多轮循环 |
| `POST /api/agent/reflect` | ReAct + 反思审查 |
| `POST /api/agent/mcp` | MCP 协议工具调用 |

### 🔌 MCP Server（工具调用示例）

```bash
cd mcp-server
source venv/bin/activate
python weather_server.py
```

MCP 客户端启动时自动发现 `get_weather` 工具（真实 wttr.in API），LLM 按需调用。

---

## 快速开始

### 前置依赖

- Node.js 20+（⚠️ 必须 20 或更高版本）
- [Ollama](https://ollama.com) 桌面客户端
- Docker Desktop（运行 ChromaDB）
- DeepSeek API Key（从 [platform.deepseek.com](https://platform.deepseek.com) 获取）

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入你的 DEEPSEEK_API_KEY
```

### 2. 启动 Ollama

下载安装 [Ollama 桌面客户端](https://ollama.com)，启动后运行：

```bash
# 拉取嵌入模型
ollama pull bge-m3
```

### 3. 启动 ChromaDB

```bash
# 首次创建容器
docker run -d --name chroma -p 8000:8000 chromadb/chroma:latest

# 后续启动
docker start chroma
```

> 💡 **或者用 docker-compose 一键启动**：项目根目录的 [docker-compose.yml](docker-compose.yml) 同时管理 ChromaDB + Ollama 两个容器，运行 `docker compose up -d` 即可，适合纯 Docker 环境。首次启动会自动拉取 `chromadb/chroma` 和 `ollama/ollama` 镜像并下载 `bge-m3` 模型，耗时较长请耐心等待。

### 4. 启动 Reranker 重排序服务

```bash
cd reranker

# 创建虚拟环境（首次）
python3 -m venv venv
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 启动服务（端口 8001）
uvicorn server:app --host 0.0.0.0 --port 8001
```

> 使用 BAAI/bge-reranker-v2-m3 模型，提供 `/rerank` 和 `/health` 接口。

### 5. 安装依赖

```bash
npm install
```

### 6. 灌入知识库

数据通过以下途径获取并灌入 ChromaDB：

| 途径 | 状态 | 数量 | 质量 | 说明 |
|------|------|------|------|------|
| AI 自生成 | ✅ 已入库 | 15 条 | 高 | DeepSeek 出题+回答+自评，人工筛选 |
| 中文医疗对话数据集 | ✅ 已入库 | 2015 条 | 中 | GitHub 开源数据，筛出儿科部分 |
| 权威指南提炼 | ❌ 未做 | 0 | 最高 | AAP/中华医学会儿科 PDF → Q&A 灌库 |

#### 途径 1：AI 自生成

```
generate-samples.ts
  → DeepSeek 按 6 大分类生成 50 个育儿问题
  → 用 System Prompt 逐个回答
  → DeepSeek 自评打分（1-10 分）
  → 每个分类取 top 3，共 15 条
  → bge-m3 embedding → ChromaDB rag_samples
```

#### 途径 2：公开中文医疗数据集

来源：[Chinese-medical-dialogue-data](https://github.com/Toyhom/Chinese-medical-dialogue-data) — GitHub 开源中文医疗对话数据集

```
ingest-medical-qa.ts
  → 读取 Pediatric_儿科/儿科5-14000.csv（GB2312 编码）
  → 用婴儿关键词筛选（宝宝/月龄/母乳/辅食/小儿…）
  → 排除成人关键词（性功能/前列腺/更年期…）
  → 去重
  → bge-m3 embedding → ChromaDB rag_medical（上限 2000 条）
```

#### 途径 3：权威指南提炼（计划中）

```
下载 AAP / 中华医学会儿科分会公开指南 PDF
  → pdf-parse 拆段
  → DeepSeek 从每段提炼 1 个 Q&A
  → 人工审核
  → 灌库
```

#### ChromaDB 集合说明（选做）

系统将不同来源的数据存入**两个独立集合**，检索时会并行搜索两个集合并合并结果：

| 集合名 | 来源 | 数量 | 灌库脚本 |
|--------|------|------|----------|
| `rag_samples` | AI 自生成 | 15 条 | `server/scripts/generate-samples.ts` |
| `rag_medical` | 中文医疗数据集 | 2015 条 | `server/scripts/ingest-medical-qa.ts` |

**创建集合**（确保 Ollama 已启动，用于生成 embedding）：

```bash
# 集合 1：AI 自生成样本（15 条，需要 DeepSeek API Key）
npx tsx server/scripts/generate-samples.ts

# 集合 2：中文医疗对话数据（2015 条，需先下载数据集）
# 下载 Chinese-medical-dialogue-data，将 Pediatric_儿科/儿科5-14000.csv 放到 knowledge_base/
npx tsx server/scripts/ingest-medical-qa.ts
```

检索配置在 [server/src/config/index.ts](server/src/config/index.ts#L34)：

```typescript
searchCollections: ['rag_samples', 'rag_medical'],  // 并行搜索这两个集合
```

> 💡 **只建一个集合也行**：将所有数据灌入同一个集合后，修改 `searchCollections` 为 `['你的集合名']` 即可。

### 7. 启动开发环境

```bash
# 同时启动前后端
npm run dev

# 或分别启动
npm run dev:server   # 后端 http://localhost:3001
npm run dev:client   # 前端 http://localhost:5173
```

## API 文档

### POST /api/chat

聊天接口，支持流式和非流式两种模式。

**流式请求**（默认）：
```bash
curl -X POST http://localhost:3001/api/chat?stream=true \
  -H "Content-Type: application/json" \
  -d '{"message": "宝宝发烧怎么办？"}'
```

**非流式请求**：
```bash
curl -X POST http://localhost:3001/api/chat?stream=false \
  -H "Content-Type: application/json" \
  -d '{"message": "宝宝发烧怎么办？"}'
```

### POST /api/upload

文件上传接口：
```bash
curl -X POST http://localhost:3001/api/upload \
  -F "file=@宝宝体检报告.pdf"
```

### GET /api/health

健康检查：
```bash
curl http://localhost:3001/api/health
```

## RAG 管道流程

```
用户提问
  ↓
1️⃣ Query Rewrite（条件触发：代词/指示词 + 有历史）
  ↓
2️⃣ Vector Search（Ollama bge-m3 → Chroma 相似度搜索 topK=10）
  ↓
3️⃣ Rerank（DeepSeek 精排，取 topK=4）
  ↓
4️⃣ Context Builder（组装带引用标记的上下文）
  ↓
5️⃣ DeepSeek 生成回答（SSE 流式 / JSON 非流式）
  ↓
前端展示答案 + 引用来源 + 相关性分数
```

## 降级策略

系统在多个环节设有自动降级机制，确保在任何子服务异常时仍能正常回复用户：

### 1. 重排序降级（三级回退链）

```
BGE Reranker 服务（首选，60s 超时）
  ↓ 超时/不可用
DeepSeek LLM 精排（备选）
  ↓ 也失败
原始向量搜索结果取 topK（最终兜底）
```

- 文档数 ≤ topK 时自动跳过重排序，直接计算距离分数
- BGE Reranker 启动时会预热，预热失败不阻塞服务启动

### 2. 意图路由降级（三级分类）

```
关键词匹配置信度 ≥ 0.9 → 直接使用关键词结果（<1ms）
关键词匹配置信度 [0.8, 0.9) → 触发 LLM 复核
关键词置信度 < 0.8 → LLM 分类
  ↓ LLM 调用失败
回退为 'general' 通用类别（最终兜底）
```

### 3. RAG 管道各环节降级

**查询改写**：
- 有代词 + 有对话历史 → DeepSeek 指代消解
- DeepSeek 改写失败 → 退回原始查询

**向量搜索**（多集合并行）：
- 单个集合搜索失败 → 返回 `[]`，不影响其他集合
- 所有集合结果合并后取 topK

**重排序** → 见上方「三级回退链」

**上下文构建**：
- 有文档 → 组装带引用标记的上下文注入提示词
- 无文档（全空）→ `context=''` → 降级为**直接 LLM 回答**（无 RAG 增强）

**DeepSeek 生成**：
- 有 RAG 上下文 → 基于知识库精准回答
- 无 RAG 上下文 → 仅凭训练数据通用回答

### 4. 客户端降级

- **语音识别**：浏览器不支持 Web Speech API 时，语音输入按钮自动禁用，状态显示为 `'unsupported'`
- **DeepSeek API**：30s 超时 + 1 次自动重试，对 401 / 429 / 网络错误给出中文提示

### 降级原则

| 原则 | 说明 |
|------|------|
| **永不崩溃** | 任何子服务异常都不会导致整个请求失败 |
| **优雅降级** | 逐级回退，从最优方案逐步退到兜底方案 |
| **用户无感** | 降级时用户仍能获得回答，仅可能缺少 RAG 增强内容 |
| **日志可观测** | 每次降级都会记录 `warn` 日志，方便排查 |

## 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                       🖥️  用户浏览器                               │
│                                                                  │
│   React 18 · TypeScript · Vite · Less（\*.module.less）· SSE 流式接收 │
│   http://localhost:5173                                          │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │  HTTP / SSE
                               │
                               ▼
╔══════════════════════════════════════════════════════════════════╗
║                  🧠 Baby AI Server  (:3001)                       ║
║                  Express.js + TypeScript                          ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  ┌─── Routes ───────────────────────────────────────────────┐   ║
║  │  POST /api/chat     聊天接口（流式 SSE / 非流式 JSON）      │   ║
║  │  POST /api/upload   文件上传（PDF / TXT / 图片）           │   ║
║  │  GET  /api/health   健康检查                               │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║    │                                                              ║
║    ▼                                                              ║
║  ┌─── 🧭 意图路由 ──────────────────────────────────────────┐   ║
║  │  关键词（<1ms）→ 中置信触发 LLM 复核 → 低置信 LLM 分类     │   ║
║  │  最终兜底 → 'general' 通用类别                              │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║    │                                                              ║
║    ▼                                                              ║
║  ┌─── 📚 RAG 管道 ──────────────────────────────────────────┐   ║
║  │                                                             │   ║
║  │  ① 查询改写 ───→ ② 向量检索 ───→ ③ 重排序 ───→ ④ 上下文   │   ║
║  │       │               │               │              │      │   ║
║  │       ▼               ▼               ▼              ▼      │   ║
║  │  DeepSeek         Ollama          BGE /           拼装      │   ║
║  │  指代消解         bge-m3          DeepSeek        提示词    │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║    │                                                              ║
║    ▼                                                              ║
║  ┌─── 🤖 LLM 调用 ──────────────────────────────────────────┐   ║
║  │  DeepSeek API（外部）· chat/completions · temperature=0.7  │   ║
║  │  30s 超时 · 1 次自动重试                                    │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║                                                                    ║
╚══════════════╪══════════════╪═════════════════════════════════════╝
               │              │
               ▼              ▼
╔══════════════════╗  ╔══════════════════════╗
║  🐍 Reranker     ║  ║  🗄️ ChromaDB         ║
║  (:8001)         ║  ║  (:8000)             ║
║                  ║  ║                      ║
║  FastAPI         ║  ║  Docker 容器           ║
║  BAAI/bge-       ║  ║                      ║
║  reranker-v2-m3  ║  ║  ┌─ rag_samples (15) ║
║                  ║  ║  └─ rag_medical (2k) ║
║  重排序打分       ║  ║                      ║
║  输出 [0,1] 分数  ║  ║  多集合并行搜索       ║
╚══════════════════╝  ╚══════════════════════╝

  🦙 Ollama  (:11434)  —  本地客户端，非 Docker
     bge-m3 嵌入模型：文本 → 1024维向量
```

### 请求生命周期

```
用户输入 "宝宝发烧怎么办？"
  │
  ├── 1. 意图路由 ──→ 关键词匹配 → 识别为「疾病护理」类别
  │
  ├── 2. 查询改写 ──→ 无代词/无历史 → 跳过，使用原始查询
  │
  ├── 3. 向量检索 ──→ Ollama bge-m3 生成查询向量
  │       │
  │       └──→ ChromaDB 并行搜索 rag_samples + rag_medical
  │           返回 topK=10 篇候选文档
  │
  ├── 4. 重排序 ────→ BGE Reranker 对 10 篇精排打分，取 topK=4
  │       │           (BGE 不可用 → DeepSeek 排序 → 原始 topK)
  │
  ├── 5. 上下文构建 → "[1] 宝宝发烧护理指南... [2] 小儿退烧方法..."
  │
  └── 6. 生成回答 ──→ DeepSeek SSE 流式生成
          │
          └──→ 前端逐字渲染 + 展示引用来源
```

## 项目结构

```
baby-ai/
├── client/                # 前端 React 应用
│   └── src/
│       ├── components/    # UI 组件
│       │   ├── chat/      # 聊天相关组件
│       │   ├── input/     # 输入相关组件
│       │   ├── layout/    # 布局组件
│       │   └── shared/    # 通用组件
│       ├── hooks/         # 自定义 Hooks
│       ├── services/      # API 调用层
│       ├── styles/        # 全局样式（\*.module.less）
│       └── types/         # TypeScript 类型
├── server/                # 后端 Express 应用
│   └── src/
│       ├── routes/        # 路由处理
│       ├── services/      # 业务逻辑
│       │   └── rag/       # RAG 管道（5个步骤）
│       ├── middleware/     # Express 中间件
│       ├── types/         # TypeScript 类型
│       └── utils/         # 工具函数
├── python-server/         # Python 后端服务（FastAPI）
│   ├── app/
│   │   ├── services/
│   │   │   ├── rag/       # 检索系统（embedding + retriever + reranker）
│   │   │   ├── agent/     # Agent 逻辑（base + unified + reflection + mcp）
│   │   │   ├── pipeline/  # 预处理管线（rewrite + intent + session + chat）
│   │   │   └── upload/    # 文件上传
│   │   ├── skills/        # Agent 技能（search + review + weather）
│   │   └── models/        # Pydantic 模型
│   └── scripts/           # 评估、灌库、基准测试脚本
├── reranker/              # BGE 重排序服务（独立部署）
├── mcp-server/            # MCP 天气服务（Agent 工具调用示例）
├── knowledge_base/        # 知识库文档
├── docker-compose.yml     # ChromaDB + Ollama
└── .env.example           # 环境变量模板
```

## SSE 事件格式

| event | data | 说明 |
|---|---|---|
| `token` | `{"text":"..."}` | 文本内容块 |
| `references` | `{"references":[...]}` | 引用来源列表 |
| `status` | `{"stage":"..."}` | 管道阶段状态 |
| `done` | `{"messageId":"...","totalTokens":0}` | 流式结束 |
| `error` | `{"code":"...","message":"..."}` | 错误信息 |

## 前端 SSE 渲染优化

流式输出场景的核心挑战：每个 token 到达时如果直接 `setState` → 全量重渲染 → ReactMarkdown 完整解析，会导致 O(n²) 级别的计算开销（1000 token 的回复 ≈ 1000 次 Markdown 解析）。以下三项优化针对性地解决了这个问题：

### 1. React.memo 避免已完成消息重渲染

[MessageBubble](client/src/components/chat/MessageBubble.tsx) 使用 `React.memo` 包裹，浅比较 props。流式输出第 11 条消息时，前 10 条已完成的消息直接跳过重渲染。

### 2. Token 批处理（50ms 窗口）

[useChat](client/src/hooks/useChat.ts) 的 `onToken` 回调不再逐 token 调用 `setMessages`，而是将 token 积累到 ref 中，每 50ms 批量 flush 一次。对于每秒 30-50 token 的流，渲染频率从 ~40 次/秒降到 ~20 次/秒。

### 3. 流式期间纯文本渲染

[MessageBubble](client/src/components/chat/MessageBubble.tsx)、[GrowthAnalysis](client/src/components/growth/GrowthAnalysis.tsx)、[StoryTime](client/src/components/play/StoryTime.tsx) 在 SSE 流式输出过程中渲染为纯文本（含闪烁光标），仅在 `done` 事件后切换回 `ReactMarkdown`。这消除了流式期间所有无效的 remark → rehype 解析开销。

```
流式链路（优化后）：
  SSE token → ref 积累（50ms timer）
    → flush → setMessages 一次提交整批
      → React.memo: 已完成消息 ✅ 跳过
      → 流式消息: <p>纯文本+光标</p> ✅ 无 Markdown 解析
      → done 后: <ReactMarkdown> ✅ 只解析一次
```

## 待实现功能

| 功能 | 优先级 | 说明 |
|------|------|------|
| **权威指南提炼** | 🔴 高 | 下载 AAP / 中华医学会儿科分会公开指南 PDF → 拆段 → DeepSeek 提炼 Q&A → 灌库。详见「灌入知识库 → 途径 3」 |
| **用户认证系统** | 🔴 高 | 目前无登录/注册机制，所有用户共用同一会话空间。后续计划引入 JWT/Session 认证，实现多用户数据隔离 |
| **对话持久化存储** | 🔴 高 | 对话历史当前仅存于服务端内存（`Map<sessionId, Message[]>`），服务重启后全部丢失。计划接入 SQLite 或 PostgreSQL 做会话持久化 |
| **跨会话记忆** | 🔴 高 | 目前 AI 只在单次会话内有上下文记忆，换个会话就"失忆"。计划实现：会话结束后提取关键信息（宝宝月龄、过敏史、关注主题等）→ 灌入长期记忆库 → 新会话时检索注入，让 AI 跨多天对话也能记住用户说过的话 |
| **自动化测试** | 🟡 中 | 目前项目尚未覆盖单元测试和集成测试。计划引入 Vitest（前端）+ Jest/Supertest（后端），覆盖 RAG 管道核心链路 |
| **移动端适配** | 🟡 中 | 前端当前以桌面端为主，移动端仅在 `index.html` 设置了 viewport，部分组件在窄屏下体验待优化 |
| **多语言支持** | 🟢 低 | 目前仅支持中文，包括 UI 文案和 AI 回复。后续可通过 i18n 扩展英文等多语言 |

## License

[MIT](https://github.com/smallYuanbao/baby-ai/blob/main/LICENSE)
