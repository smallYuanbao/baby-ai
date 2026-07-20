import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# 获取DeepSeek相关环境变量
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")


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

RERANKER_URL = os.getenv("RERANKER_URL", "http://127.0.0.1:8001/rerank")
