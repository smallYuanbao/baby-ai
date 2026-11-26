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

# 病名 → 常见表现。
#
# 为什么要有这一行：用户往往用症状提问（"高烧+眼睛红+草莓舌是什么病"），
# 而语料里的标题写的是病名（"孩子如何判断是川崎病"）。两种写法在向量空间里
# 并不总是近邻，BM25 更是完全对不上——症状词在病名文档里出现得太少。
#
# 灌库时把常见表现拼进正文，让「症状词」和「病名」出现在同一篇文档里：
#   · 症状式提问能通过 BM25 命中病名文档；
#   · 向量检索的语义距离也会被拉近。
# 只在灌库阶段做，查询链路零改动、零延迟。
#
# 注意：只给「已确认要补的主题」写提示，不要给盲测题涉及的主题提前写，
# 否则等于把答案提前塞进知识库，盲测数字就失去意义。
SYMPTOM_HINTS = {
    "川崎": "持续高热不退、双眼结膜充血、草莓舌、口唇干红皲裂、皮疹、手足硬肿、颈部淋巴结肿大",
    "荨麻疹": "皮肤突然起风团、成片隆起、剧烈瘙痒、此起彼伏、来去快",
    "铁剂": "缺铁性贫血补铁；两餐之间服用、搭配维生素C、避免与奶同服、大便变黑",
    "语言发育": "说话晚、词汇少、不会说短句、发音不清、听不懂指令",
    "乳糖不耐": "喝奶后腹泻、腹胀、排气多、大便酸臭、体重增长慢",
    "多动症": "坐不住、注意力不集中、冲动、丢三落四、学习困难",
    "弱视": "看东西眯眼、歪头、视力低于同龄、体检视力不达标",
    "斜视": "眼位偏斜、斗鸡眼、看东西歪头、阳光下闭一只眼",
    "性早熟": "女孩八岁前乳房发育、男孩九岁前睾丸增大、骨龄超前、身高突增",
    "抽动": "不自主眨眼、清嗓子、耸肩、面部抽动、紧张时加重",
    "贫血": "面色苍白、乏力、血红蛋白低、食欲差、注意力下降",
    "肠绞痛": "婴儿傍晚固定哭闹、蹬腿、腹胀、排气后缓解",
    "牛奶蛋白过敏": "喝奶后湿疹、腹泻、血便、呕吐、生长发育迟缓",
}


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
        hint = SYMPTOM_HINTS.get(item["topic"])
        hint_line = f"【常见表现】{hint}\n" if hint else ""
        text = (
            f"【{item['department']}】{item['title']}\n"
            f"{hint_line}"
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
