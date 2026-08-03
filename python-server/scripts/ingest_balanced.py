"""
按意图分类均衡灌入儿科数据集

功能：
  1. 读 儿科5-14000.csv（GB2312 编码）
  2. 用意图路由的关键词对每条数据做分类
  3. 质量过滤（问题/回答长度、排除成人相关）
  4. 每类取 top-N 条高质量数据
  5. 生成 embedding → 写入 ChromaDB rag_medical

运行：
  python scripts/ingest_balanced.py

配置：
  PER_CATEGORY: 每类灌入多少条（默认 300）
  DRY_RUN: 是否只预览不灌入（默认 True，先看效果）
"""

import csv
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.rag.embedding import get_embedding, chroma_client
from app.services.pipeline.intent import KEYWORD_RULES, Intent

# ============================================================
# 配置
# ============================================================

CSV_PATH = os.path.join(os.path.dirname(__file__), "儿科5-14000.csv")
PER_CATEGORY = 600          # 每类最多灌入条数
DRY_RUN = False              # True = 只预览不灌入
BATCH_SIZE = 10             # 每批灌入条数
MAX_WORKERS = 4             # 并发数

# 成人/非儿科排除词
EXCLUDE_KEYWORDS = [
    "性功能", "阳痿", "早泄", "前列腺", "月经", "痛经",
    "更年期", "绝经", "乳腺增生", "宫颈", "卵巢",
    "成人", "老年", "中年", "抽烟", "饮酒", "开车", "上班", "上学",
    "高血压", "糖尿病", "冠心病", "痛风", "脑梗",
]

# ============================================================
# Step 1: 读 CSV + 意图分类
# ============================================================

def classify_question(question: str) -> tuple[Intent, float]:
    """用 KEYWORD_RULES 分类一条问题，返回 (意图, 置信度)"""
    best_intent: Intent = "general"
    best_conf = 0.0
    for rule in KEYWORD_RULES:
        matched = [kw for kw in rule.keywords if kw in question]
        if matched:
            conf = min(rule.confidence + len(matched) * 0.02, 1.0)
            if conf > best_conf:
                best_conf = conf
                best_intent = rule.intent
    return best_intent, best_conf


def is_valid_row(question: str, answer: str) -> bool:
    """质量过滤"""
    if len(question) < 10:       # 问题太短（含"无"这类）
        return False
    if len(answer) < 20:         # 回答太短
        return False
    combined = question + answer
    for kw in EXCLUDE_KEYWORDS:
        if kw in combined:
            return False
    return True


def read_and_classify() -> dict[Intent, list[dict]]:
    """读 CSV → 分类 → 质量过滤 → 按意图分组"""
    print(f"📂 读取 {CSV_PATH}...")

    with open(CSV_PATH, "r", encoding="gb2312", errors="replace") as f:
        reader = csv.reader(f)
        header = next(reader)  # 跳过表头: department,title,ask,answer

        categorized: dict[Intent, list[dict]] = defaultdict(list)
        total = 0
        valid = 0
        stats = defaultdict(int)

        for row in reader:
            total += 1
            if len(row) < 4:
                continue

            department, title, question, answer = row[0], row[1], row[2], row[3]

            if not is_valid_row(question, answer):
                continue

            valid += 1
            intent, conf = classify_question(question)
            stats[intent] += 1

            # 只保留高质量数据（置信度 >= 0.85）
            if conf >= 0.85:
                categorized[intent].append({
                    "department": department,
                    "title": title,
                    "question": question[:500],     # 截断
                    "answer": answer[:800],         # 截断
                    "confidence": conf,
                })

            if total % 20000 == 0:
                print(f"  已处理 {total} 行...")

    print(f"\n  总行数: {total}")
    print(f"  有效行数: {valid}")
    print(f"  分类统计:")
    for intent in ["emergency", "illness", "feeding", "sleep", "development", "vaccine", "daily_care", "general"]:
        count = stats.get(intent, 0)
        high_quality = len(categorized.get(intent, []))
        print(f"    {intent:15s}: {count:5d} 条匹配, {high_quality:5d} 条高质量(conf>=0.85)")

    return categorized


# ============================================================
# Step 2: 均衡采样
# ============================================================

def sample_balanced(categorized: dict[Intent, list[dict]]) -> list[dict]:
    """每类取 top-N，均衡采样（跨类别去重）"""
    selected = []
    seen_titles = set()

    # 按候选数量从少到多排列，候选少的类别优先选取（避免被候选多的类别抢走）
    intent_order = ["emergency", "illness", "feeding", "sleep", "development", "vaccine", "daily_care"]
    # daily_care 和 sleep 候选最少，优先选
    priority_order = ["daily_care", "sleep", "vaccine", "development", "feeding", "emergency", "illness"]

    for intent in priority_order:
        items = categorized.get(intent, [])
        items.sort(key=lambda x: x["confidence"], reverse=True)

        sampled = []
        for item in items:
            if len(sampled) >= PER_CATEGORY:
                break
            # 去重：同一 title 如果已被其他类别选中就跳过
            if item["title"] not in seen_titles:
                sampled.append(item)
                seen_titles.add(item["title"])

        selected.extend(sampled)
        print(f"  {intent}: 选取 {len(sampled)}/{len(items)} 条")

    print(f"\n  总计选取: {len(selected)} 条（已去重）")
    return selected


# ============================================================
# Step 3: 灌入 ChromaDB
# ============================================================

def ingest(selected: list[dict]):
    """逐条生成 embedding → 灌入 ChromaDB"""
    total = len(selected)
    collection = chroma_client.get_or_create_collection(name="rag_medical")

    ingested = 0
    failed = 0
    start_time = time.time()

    for batch_start in range(0, total, BATCH_SIZE):
        batch = selected[batch_start:batch_start + BATCH_SIZE]
        batch_num = batch_start // BATCH_SIZE + 1
        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE

        for item in batch:
            try:
                text = f"【{item['department']}】{item['title']}\n问：{item['question']}\n答：{item['answer']}"
                emb = get_embedding(text)

                import uuid
                doc_id = f"med_{uuid.uuid4().hex[:8]}"

                collection.add(
                    documents=[text],
                    embeddings=[emb],
                    ids=[doc_id],
                    metadatas=[{
                        "source": "Chinese-medical-dialogue-data",
                        "department": item["department"],
                        "title": item["title"],
                        "type": "medical_qa",
                    }],
                )
                ingested += 1

                if ingested % 10 == 0:
                    elapsed = time.time() - start_time
                    eta = elapsed / ingested * (total - ingested)
                    print(f"  批次 {batch_num}/{total_batches}: "
                          f"{ingested}/{total} (ETA: {eta/60:.1f}分钟)")

            except Exception as e:
                failed += 1
                if failed <= 3:
                    print(f"  ❌ 单条失败: {e}")

        # 批次间短暂休息
        if batch_start + BATCH_SIZE < total:
            time.sleep(0.3)

    elapsed = time.time() - start_time
    print(f"\n✅ 灌入完成！成功: {ingested}, 失败: {failed}, 耗时: {elapsed/60:.1f}分钟")


# ============================================================
# Main
# ============================================================

def main():
    print("=" * 60)
    print("🏥 按意图分类均衡灌入")
    print(f"   每类上限: {PER_CATEGORY} 条, DRY_RUN: {DRY_RUN}")
    print("=" * 60 + "\n")

    categorized = read_and_classify()
    selected = sample_balanced(categorized)

    if DRY_RUN:
        print(f"\n🔍 DRY_RUN 模式 — 预览前 5 条样本：\n")
        for item in selected[:5]:
            print(f"  [{item['department']}] {item['title']}")
            print(f"  问: {item['question'][:100]}...")
            print(f"  答: {item['answer'][:100]}...")
            print()
        print(f"如需灌入，设置 DRY_RUN = False 后重新运行")
    else:
        print(f"\n📚 开始灌入 {len(selected)} 条...\n")
        ingest(selected)


if __name__ == "__main__":
    main()
