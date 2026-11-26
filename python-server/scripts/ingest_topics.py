"""定向补库：把长尾主题的问答补进 rag_medical。

背景：`ingest_balanced.py` 按意图每类只取 600 条，猩红热、麦粒肿、地图舌
这类长尾主题很容易被抽样漏掉。盲测发现索引里这些主题只有 0～1 条。

本脚本不按意图均衡，而是按主题关键词从原始 CSV 里精确捞取，适合补盲测
暴露出来的知识缺口。

用法：

    # 预览（不联网）
    docker compose -f docker-compose.server.yml --profile ingest run --rm ingest \
      python scripts/ingest_topics.py --dry-run

    # 补库（每主题最多 100 条）
    docker compose -f docker-compose.server.yml --profile ingest run --rm ingest \
      python scripts/ingest_topics.py --per-topic 100

    # 只补指定主题
    ... python scripts/ingest_topics.py --topics 猩红热,麦粒肿 --per-topic 50

注意：ID 与 `ingest_balanced.py` 一致（department|title|question 的 SHA1），
同一篇文档重复执行会 upsert 覆盖，不会产生重复。
"""

import argparse
import csv
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.rag.embedding import chroma_client, get_embedding

CSV_PATH = os.path.join(os.path.dirname(__file__), "儿科5-14000.csv")
COLLECTION = "rag_medical"

DEFAULT_TOPICS = [
    "猩红热", "麦粒肿", "O型腿", "包皮", "分离焦虑", "打人",
    "地图舌", "鼻出血", "水痘", "幼儿急疹", "中耳炎", "腺样体",
    "近视", "咬指甲", "乳牙", "口吃",
]


def _valid(question: str, answer: str) -> bool:
    return len(question) >= 10 and len(answer) >= 20


def _doc_id(department: str, title: str, question: str) -> str:
    raw = f"{department}|{title}|{question}".encode("utf-8")
    return "med_" + hashlib.sha1(raw).hexdigest()[:16]


def select_rows(topics: list[str], per_topic: int) -> list[dict]:
    selected: list[dict] = []
    seen: set[str] = set()

    with open(CSV_PATH, encoding="gb2312", errors="replace") as f:
        rows = list(csv.reader(f))[1:]

    for topic in topics:
        hits = []
        for row in rows:
            if len(row) < 4:
                continue
            department, title, question, answer = row[0], row[1], row[2], row[3]
            if topic not in title and topic not in question:
                continue
            if not _valid(question, answer):
                continue
            doc_id = _doc_id(department, title, question)
            if doc_id in seen:
                continue
            seen.add(doc_id)
            hits.append({
                "department": department,
                "title": title,
                "question": question[:500],
                "answer": answer[:800],
                "topic": topic,
                "id": doc_id,
            })
            if len(hits) >= per_topic:
                break
        print(f"  {topic:6} 选取 {len(hits)} 条")
        selected.extend(hits)

    return selected


def ingest(rows: list[dict]) -> None:
    coll = chroma_client.get_or_create_collection(name=COLLECTION)
    total = len(rows)
    for i, item in enumerate(rows, 1):
        text = (
            f"【{item['department']}】{item['title']}\n"
            f"问：{item['question']}\n答：{item['answer']}"
        )
        emb = get_embedding(text)
        coll.upsert(
            documents=[text],
            embeddings=[emb],
            ids=[item["id"]],
            metadatas=[{
                "source": "targeted-ingest",
                "department": item["department"],
                "title": item["title"],
                "type": "medical_qa",
                "topic": item["topic"],
            }],
        )
        if i % 10 == 0 or i == total:
            print(f"  已灌入 {i}/{total}")


def main() -> int:
    parser = argparse.ArgumentParser(description="按主题定向补库 rag_medical")
    parser.add_argument("--topics", default=",".join(DEFAULT_TOPICS),
                        help="逗号分隔的主题关键词")
    parser.add_argument("--per-topic", type=int, default=100)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    topics = [t.strip() for t in args.topics.split(",") if t.strip()]
    print(f"主题: {topics}")
    print(f"每主题上限: {args.per_topic}")

    rows = select_rows(topics, args.per_topic)
    print(f"总计: {len(rows)} 条")

    if args.dry_run:
        for item in rows[:10]:
            print(f"  [{item['topic']}] {item['title']}")
        return 0

    ingest(rows)
    print("✅ 定向补库完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
