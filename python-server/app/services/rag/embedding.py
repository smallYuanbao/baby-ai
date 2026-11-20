import chromadb
from chromadb.config import Settings

from app.core.config import CHROMA_HOST, CHROMA_PORT, OLLAMA_BASE_URL, OLLAMA_PORT, OLLAMA_MODEL

# 初始化 chroma client（连接 Docker ChromaDB）
chroma_client = chromadb.HttpClient(
    host=CHROMA_HOST,
    port=CHROMA_PORT,
    settings=Settings(anonymized_telemetry=False),
)


def get_embedding(text: str) -> list[float]:
    """调用 Ollama 的 bge-m3 模型生成向量"""
    import requests

    # 兼容两种配置：纯 host（127.0.0.1）和完整 URL（http://127.0.0.1:11434）
    base = OLLAMA_BASE_URL
    if not base.startswith("http"):
        base = f"http://{base}:{OLLAMA_PORT}"

    response = requests.post(
        f"{base}/api/embed",
        json={"model": OLLAMA_MODEL, "input": [text]},
    )
    response.raise_for_status()
    return response.json()["embeddings"][0]
