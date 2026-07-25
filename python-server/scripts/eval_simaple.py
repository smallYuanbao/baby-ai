import json
import time
import os
import requests
from dotenv import load_dotenv

# 加载 .env 中的环境变量（特别是 DEEPSEEK_API_KEY）
load_dotenv()

# ================= 配置区 =================
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
SAMPLE_SIZE = 24

# 待评估的输入文件列表（为空则自动发现当前目录下所有 eval_results*.json）
EVAL_INPUT_FILES = [
    "eval_results.json",
    "eval_results_0.3.json",
    "eval_results_0.5.json",
    "eval_results_0.7.json",
    "eval_results_0.9.json",
    "eval_results_1.0.json",
    "eval_results_rrf.json",
]
# ==========================================

def call_deepseek(prompt: str, max_tokens: int = 20) -> str:
    """调用 DeepSeek API，返回回答文本"""
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "deepseek-v4-flash",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": max_tokens
    }
    resp = requests.post(f"{DEEPSEEK_BASE_URL}/chat/completions", 
                         headers=headers, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def score_faithfulness(question: str, answer: str, contexts: list) -> int:
    context_str = "\n\n".join(contexts[:3]) if contexts else "（无参考文档）"
    prompt = f"""你是一个严格的评估专家。请根据以下参考文档判断"回答"中的内容是否都能在文档中找到依据。

参考文档：
{context_str}

问题：{question}
回答：{answer}

请逐句检查回答中的每个关键声明（事实、数据、建议），判断是否能从参考文档中找到支撑。

评分标准：
  5分：所有关键声明都能在文档中找到明确依据，没有任何编造
  4分：绝大多数有依据，个别细节可能来自模型自身知识但合理
  3分：约一半有依据，存在较多推测性内容
  2分：大部分声明没有文档依据，严重依赖模型自身知识
  1分：和文档内容矛盾，或完全脱离文档编造

请只输出一个 1-5 的整数分数。不要输出其他内容。
分数："""
    raw = call_deepseek(prompt, max_tokens=10)
    try:
        return int(raw)
    except:
        return 0


def score_relevancy(question: str, answer: str) -> tuple[int, str]:
    prompt = f"""你是一个评估专家。请判断以下回答是否直接、贴切地回答了用户的问题。

注意：这是一个育儿医疗助手，回答中固定包含"就医判断"和"免责声明"段落，
这些是标准安全提示，**不算偏题内容**，不要因此扣分。

问题：{question}
回答：{answer}

请按以下格式输出：
无关内容：<指出回答中**真正跑题**的部分（医院段和免责段不算），如果没有就写"无">
分数：<1-5 的整数>

评分标准：
  5分：紧扣问题，核心回答精准
  4分：基本扣题，有轻微延伸但不过分
  3分：回答和问题沾边，但大段内容跑偏
  2分：答非所问，只有一小段在回答问题
  1分：完全没回答用户问的"""
    raw = call_deepseek(prompt, max_tokens=50)

    # 解析 "无关内容：xxx" 和 "分数：X"
    comment = ""
    score = 3  # 默认中等，避免解析失败给 0
    for line in raw.strip().split("\n"):
        if "无关内容" in line:
            comment = line.replace("无关内容：", "").replace("无关内容:", "").strip()
        if "分数" in line or line.strip().isdigit():
            try:
                score = int(line.strip().replace("分数：", "").replace("分数:", "").strip())
            except ValueError:
                pass
    return score, comment


def score_recall(question: str, key_points: str, contexts: list) -> int:
    context_str = "\n\n".join(contexts[:5]) if contexts else "（无检索文档）"
    prompt = f"""你是一个严格的评估专家。用户问题需要覆盖以下关键信息点：
{key_points}

检索到的参考文档：
{context_str}

请逐条检查每个关键信息点是否能在参考文档中找到对应内容，然后综合打分。

评分标准（严格打分）：
  5分：所有关键点都被文档覆盖，且能找到明确的对应内容
  4分：大部分关键点被覆盖（≥80%），个别点缺失
  3分：约一半关键点被覆盖（50%左右）
  2分：只有少数关键点被覆盖（≤30%）
  1分：文档完全没有覆盖任何关键信息点

请只输出一个 1-5 的整数分数。不要输出其他内容。
分数："""
    raw = call_deepseek(prompt, max_tokens=10)
    try:
        return int(raw)
    except:
        return 0


# ================= 主流程 =================

def evaluate_one_file(input_file: str):
    """评估单个文件，返回 summary dict"""
    if not os.path.exists(input_file):
        print(f"  ⚠️ 文件不存在，跳过: {input_file}")
        return None

    with open(input_file, "r", encoding="utf-8") as f:
        eval_results = json.load(f)

    # 生成输出文件名：eval_results_0.3.json → eval_results_judge_0.3.json
    base = os.path.splitext(input_file)[0]  # 去掉 .json
    if base == "eval_results":
        output_file = "eval_results_judge.json"
    else:
        # eval_results_0.3 → eval_results_judge_0.3
        suffix = base.replace("eval_results_", "")
        output_file = f"eval_results_judge_{suffix}.json"

    results = []
    total = len(eval_results)
    print(f"\n📂 {input_file} ({total} 条) → {output_file}")
    print("-" * 50)

    for i, item in enumerate(eval_results):
        q = item["question"]
        print(f"  [{i+1}/{total}] {q[:40]}...")

        key_points = "；".join(item.get("expected_points", []))
        answer = item.get("answer")
        contexts = [ref["text"] for ref in item.get("references", [])]

        faith = score_faithfulness(q, answer, contexts)
        relevancy, irrelevancy_comment = score_relevancy(q, answer)
        recall = score_recall(q, key_points, contexts) if key_points else 3

        results.append({
            "question": q,
            "answer": answer[:500],
            "references": contexts[:3],
            "expected_points": item.get("expected_points", []),
            "faithfulness": faith,
            "relevancy": relevancy,
            "relevancy_comment": irrelevancy_comment,
            "recall": recall,
        })
        print(f"      忠实度={faith}  相关性={relevancy}  召回率={recall}")

        time.sleep(0.3)

    # 汇总
    avg_faith = sum(r["faithfulness"] for r in results) / len(results)
    avg_rel = sum(r["relevancy"] for r in results) / len(results)
    avg_recall = sum(r["recall"] for r in results) / len(results)

    # 保存
    summary = {
        "avg_faithfulness": round(avg_faith, 2),
        "avg_relevancy": round(avg_rel, 2),
        "avg_recall": round(avg_recall, 2),
        "total_samples": len(results),
    }
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "details": results}, f, ensure_ascii=False, indent=2)

    print(f"  ✅ {output_file}  忠实度={avg_faith:.1f}  相关性={avg_rel:.1f}  召回率={avg_recall:.1f}")
    return summary


def main():
    all_summaries = {}

    for input_file in EVAL_INPUT_FILES:
        summary = evaluate_one_file(input_file)
        if summary:
            label = os.path.splitext(input_file)[0]
            all_summaries[label] = summary

    # 总览
    if all_summaries:
        print("\n" + "=" * 60)
        print("📊 全部评估总览")
        print("=" * 60)
        print(f"{'文件':<30s} {'忠实度':>6s} {'相关性':>6s} {'召回率':>6s}")
        print("-" * 60)
        for label, s in all_summaries.items():
            print(f"{label:<30s} {s['avg_faithfulness']:>6.2f} {s['avg_relevancy']:>6.2f} {s['avg_recall']:>6.2f}")


if __name__ == "__main__":
    main()