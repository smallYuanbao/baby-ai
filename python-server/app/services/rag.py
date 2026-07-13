import os
import chromadb
from chromadb.config import Settings

# 获取CHROMA相关环境变量
CHROMA_HOST = os.getenv("CHROMA_HOST", "localhost")
CHROMA_PORT = os.getenv("CHROMA_PORT", "8000")
COLLECTION_NAME = os.getenv("CHROMA_COLLECTION", "rag_docs")
SEARCH_COLLECTIONS = os.getenv("CHROMA_SEARCH_COLLECTIONS", "rag_samples,rag_medical").split(",")

# 获取OLLAMA的相关环境变量配置
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "localhost")
OLLAMA_PORT = os.getenv("OLLAMA_PORT", "11434")
OLLAMA_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "bge-m3")

# 初始化 chroma client（连接 Docker ChromaDB）
chroma_client = chromadb.HttpClient(
    host=CHROMA_HOST,
    port=CHROMA_PORT,
    settings=Settings(anonymized_telemetry=False),
)

def get_embedding(text: str) -> list[float]:
    """调用 Ollama 的 bge-m3 模型生成向量"""
    import requests
    response = requests.post(
        f"http://{OLLAMA_BASE_URL}:{OLLAMA_PORT}/api/embed",
        json={"model": OLLAMA_MODEL, "input": [text]},
    )
    response.raise_for_status()
    # Ollama /api/embed 返回 {"embeddings": [[...]]}（二维数组，input 中每个字符串对应一个向量）
    return response.json()["embeddings"][0]
    
def search_docs(query: str, top_k: int = 3) -> list[str]:
    """多 collection 向量检索 + 合并排序（对齐 Node 端 searchCollections 逻辑）"""
    query_embedding = get_embedding(query)
    all_docs = []

    for coll_name in SEARCH_COLLECTIONS:
        coll = chroma_client.get_or_create_collection(name=coll_name.strip())
        results = coll.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=["documents", "distances"],
        )
        docs = results.get("documents", [[]])[0]
        distances = results.get("distances", [[]])[0]
        for doc, dist in zip(docs, distances):
            all_docs.append((doc, dist))

    # 按距离升序（越近越相关），取 top_k
    all_docs.sort(key=lambda x: x[1])
    return [doc for doc, _ in all_docs[:top_k]]
