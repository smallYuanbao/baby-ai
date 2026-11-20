"""
反查 eval_results.json 中的引用文本 → 从 ChromaDB 找回 doc_id → 更新为新格式

运行：cd python-server && python3 scripts/fix_refs.py
"""
import json
import sys
import os

# 把 python-server/ 加入模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.rag.embedding import chroma_client
from app.core.config import SEARCH_COLLECTIONS

# ---- 1. 从 ChromaDB 加载所有文档，建立 text开头 → id 的索引 ----
print("📂 加载 ChromaDB 文档...")
text_to_id = {}  # key=文本前80字, value=doc_id

for coll_name in SEARCH_COLLECTIONS:
    coll = chroma_client.get_or_create_collection(name=coll_name.strip())
    all_docs = coll.get(include=["documents"])
    ids = all_docs.get("ids", [])
    docs = all_docs.get("documents", [])
    for doc_id, doc in zip(ids, docs):
        key = doc[:80]  # 用前80字做指纹
        text_to_id[key] = doc_id
    print(f"  {coll_name}: {len(docs)} 条")

print(f"  索引总数: {len(text_to_id)} 条\n")

# ---- 2. 读旧 eval_results.json ----
with open("scripts/eval_results.json", "r", encoding="utf-8") as f:
    results = json.load(f)

# ---- 3. 逐条反查 id ----
found = 0
missing = 0
for item in results:
    old_refs = item["references"]  # list[str]
    new_refs = []
    for ref_text in old_refs:
        key = ref_text[:80]
        doc_id = text_to_id.get(key, "")
        if doc_id:
            found += 1
        else:
            missing += 1
        new_refs.append({"id": doc_id, "text": ref_text})
    item["references"] = new_refs

print(f"✅ 匹配成功: {found} 条")
print(f"⚠️  未匹配: {missing} 条")

# ---- 4. 保存 ----
with open("scripts/eval_results.json", "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

print(f"\n📁 已更新 scripts/eval_results.json")
