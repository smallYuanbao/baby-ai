"""把 AI 生成的高质量问答样本灌入 ChromaDB 的 `rag_samples` 集合。

这是 `server/scripts/ingest-samples.ts` 的 Python 版，目的：
  - 不依赖 Node / server/node_modules；
  - 复用后端同一套 Ollama embedding 调用，保证向量维度与模型一致。

数据源：`server/data/few-shot-samples.json`（15 条，字段 question/answer/score/category）

用法：
    # 容器内（推荐）
    python scripts/ingest_samples.py
    python scripts/ingest_samples.py --reset

    # 指定路径
    python scripts/ingest_samples.py --path /app/server-data/few-shot-samples.json

说明：
    - 使用内容哈希作为 ID，并调用 upsert，重复执行不会产生重复数据；
    - --reset 会先删除 rag_samples 集合再重灌（谨慎）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

# 允许 `python scripts/ingest_samples.py` 直接运行
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.rag.embedding import chroma_client, get_embedding

COLLECTION = "rag_samples"


def _candidate_paths(explicit: str | None) -> list[str]:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)
    env_path = os.environ.get("FEW_SHOT_JSON")
    if env_path:
        candidates.append(env_path)
    candidates.extend(
        [
            # compose ingest profile 里的只读挂载
            "/app/server-data/few-shot-samples.json",
            # 手动 docker cp 到 scripts/ 的兜底
            os.path.join(here, "few-shot-samples.json"),
            # 本地从仓库根运行
            os.path.join(here, "..", "..", "server", "data", "few-shot-samples.json"),
        ]
    )
    return candidates


def resolve_path(explicit: str | None) -> str:
    for path in _candidate_paths(explicit):
        if path and os.path.isfile(path):
            return os.path.abspath(path)
    tried = "\n  ".join(p for p in _candidate_paths(explicit) if p)
    raise FileNotFoundError(
        "找不到 few-shot-samples.json。用 --path 指定，或设置 FEW_SHOT_JSON。\n"
        f"已尝试:\n  {tried}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="灌入 rag_samples 集合")
    parser.add_argument("--path", default=None, help="few-shot-samples.json 路径")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="灌入前删除 rag_samples 集合（会清空该集合）",
    )
    args = parser.parse_args()

    path = resolve_path(args.path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list) or not data:
        raise SystemExit(f"{path} 不是非空数组")

    print("=" * 60)
    print(f"📚 灌入 {COLLECTION}")
    print(f"   数据源: {path}")
    print(f"   条数:   {len(data)}")
    print(f"   reset:  {args.reset}")
    print("=" * 60)

    if args.reset:
        try:
            chroma_client.delete_collection(COLLECTION)
            print(f"🧹 已删除旧集合 {COLLECTION}")
        except Exception:
            # 集合不存在时忽略
            pass

    collection = chroma_client.get_or_create_collection(name=COLLECTION)

    ok = 0
    failed = 0
    start = time.time()

    for i, item in enumerate(data, 1):
        try:
            question = str(item.get("question", "")).strip()
            answer = str(item.get("answer", "")).strip()
            if not question or not answer:
                raise ValueError("缺少 question 或 answer")

            text = f"问题：{question}\n\n回答：{answer}"
            embedding = get_embedding(text)

            # 内容哈希：同样的问答重复执行会覆盖同一条，而不是新增
            doc_id = "sample_" + hashlib.sha1(
                f"{question}|{answer}".encode("utf-8")
            ).hexdigest()[:16]

            collection.upsert(
                ids=[doc_id],
                documents=[text],
                embeddings=[embedding],
                metadatas=[
                    {
                        "source": "ai-generated-sample",
                        "category": item.get("category", ""),
                        "score": float(item.get("score", 0)),
                        "question": question,
                        "type": "qa_pair",
                    }
                ],
            )
            ok += 1
            print(f"  ✅ [{i}/{len(data)}] {question[:40]}")
        except Exception as exc:
            failed += 1
            print(f"  ❌ [{i}/{len(data)}] {exc}")

    elapsed = time.time() - start
    print(
        f"\n✅ {COLLECTION} 灌入完成: 成功 {ok}, 失败 {failed}, "
        f"耗时 {elapsed:.1f}s"
    )


if __name__ == "__main__":
    main()
