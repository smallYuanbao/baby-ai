import os
from pathlib import Path
from dotenv import load_dotenv

# 加载环境变量。
#
# ⚠️ 这里**显式指定仓库根目录的 .env**，不要改回裸的 `load_dotenv()`。
#
# 裸调用读的是「进程当前工作目录」下的 .env，于是同一份配置
# 从仓库根启动就读根 .env、从 python-server/ 启动就读 python-server/.env ——
# 而这两份文件内容并不一样（甚至各有一套 CHROMA_* 命名：根用 CHROMA_URL，
# 这里用 CHROMA_HOST + CHROMA_PORT）。改了配置却没生效，通常就是这么来的。
# 已经把两份合并成根目录这一份，并在代码里把路径钉死。
#
# 注：容器里运行时仓库根的 .env 不存在，load_dotenv 会静默跳过，
# 配置由 docker compose 的 environment 提供 —— 行为不受影响。
load_dotenv(Path(__file__).resolve().parents[3] / ".env")

# 获取DeepSeek相关环境变量
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")


# 获取CHROMA相关环境变量
CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = os.getenv("CHROMA_PORT", "8000")
COLLECTION_NAME = os.getenv("CHROMA_COLLECTION", "rag_docs")
SEARCH_COLLECTIONS = os.getenv("CHROMA_SEARCH_COLLECTIONS", "rag_samples,rag_medical").split(",")
CHROMA_USER_UPLOAD_COLLECTION = os.getenv("CHROMA_USER_UPLOAD_COLLECTION", "rag_user_uploads")

# 获取OLLAMA的相关环境变量配置
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "localhost")
OLLAMA_PORT = os.getenv("OLLAMA_PORT", "11434")
OLLAMA_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "bge-m3")

QUERY_REWRITE_ENABLED = os.getenv("QUERY_REWRITE_ENABLED", "").lower() in ["true", "1", "yes"]

RERANKER_URL = os.getenv("RERANKER_URL", "http://127.0.0.1:8011/rerank")


# ---------- LLM 调用加固（超时 / 熔断 / 备用模型） ----------

# LLM 单次调用超时（秒），防止无限等待
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "60"))

# 熔断器参数
BREAKER_FAILURE_THRESHOLD = int(os.getenv("BREAKER_FAILURE_THRESHOLD", "5"))
BREAKER_OPEN_TIMEOUT = int(os.getenv("BREAKER_OPEN_TIMEOUT", "30"))

# 备用模型（留空位：配置了 FALLBACK_API_KEY 才启用真实切换，否则走降级兜底文案）
FALLBACK_API_KEY = os.getenv("FALLBACK_API_KEY")
FALLBACK_BASE_URL = os.getenv("FALLBACK_BASE_URL")
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL")


# ---------- 缓存（高并发四件套 §4） ----------
# 检索结果 / 常见问题答案的进程内缓存，TTL 秒数 + 最大条目数
RAG_CACHE_TTL = int(os.getenv("RAG_CACHE_TTL", "300"))
RAG_CACHE_MAXSIZE = int(os.getenv("RAG_CACHE_MAXSIZE", "512"))


# ---------- growth 成长记录存储（SQLite） ----------
# 宝宝档案 + 成长记录的持久化路径（SQLite 单文件，替代原 Express 的 JSON 文件方案）
GROWTH_DB_PATH = os.getenv("GROWTH_DB_PATH", "data/growth.db")

# ---------- 会话历史存储（SQLite） ----------
# 对话历史的持久化路径（从内存 dict 落盘，服务重启不丢）
SESSION_DB_PATH = os.getenv("SESSION_DB_PATH", "data/sessions.db")

# ---------- 接口限流 ----------
# 聊天端点的限流额度。**维度按用户(不是 IP)**，见 main.py 的 _rate_limit_key。
# 抽成配置是为了能按环境调：本地/评测可以调宽，线上保持默认。
CHAT_RATE_LIMIT = os.getenv("CHAT_RATE_LIMIT", "10/minute")
