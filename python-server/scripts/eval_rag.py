# 读取测试集 → 逐条调/api/chat → 组装{question, answer, contexts, ground_truth}
# → 用RAGAS或LLM-as-Judge打分 → 输出评估报告

import json
import os
import requests

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy, context_precision, context_recall
from datasets import Dataset
from langchain_ollama import OllamaEmbeddings


# 指定 .env 的绝对路径
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL")


def read_test_questions(name: str):
    with open("test_questions.json", "r", encoding="utf-8") as f:
       test_cases = json.load(f)
       print("类型:", type(test_cases))
       print("测试集数据：", test_cases)

    import time
    total = len(test_cases)
    results = []
    start_time = time.time()

    for i, case in enumerate(test_cases, start=1):
        response = requests.post(
            "http://127.0.0.1:8002/api/chat",
            json={
                "message": case["question"],
                "session_id": "eval_test",
                "history": [],
            },
            timeout=120,
        )
        data = response.json()

        results.append({
            "question": case["question"],
            "expected_category": case["category"],
            "expected_points": case["key_points"],
            "answer": data["answer"],
            "references": data["references"],
        })

        # 进度：当前/总数 + 耗时 + ETA
        elapsed = time.time() - start_time
        avg_time = elapsed / i               # 平均每题耗时
        eta = avg_time * (total - i)          # 预估剩余时间
        print(f"  [{i:2d}/{total}] {elapsed:.0f}s | ETA {eta:.0f}s | "
              f"refs={len(data['references'])} | {case['question'][:40]}...")

    with open(f"eval_results_{name}.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n完成：{len(results)} 条")       

questions = []
answers = []
contexts_list = []
ground_truths = []


def read_eval_results():
    with open("eval_results.json", "r", encoding="utf-8") as f:
        results = json.load(f)
        for item in results:
            questions.append(item["question"])
            answers.append(item["answer"])
            contexts_list.append(item["references"])
            ground_truths.append("\n".join(item["expected_points"]))

    # 3. 组装数据集
    dataset = Dataset.from_dict({
        "question": questions,
        "answer": answers,
        "contexts": contexts_list,
        "ground_truth": ground_truths
    })

    # 用 DeepSeek 做评估的 LLM
    # 2. 初始化 DeepSeek LLM (推荐使用兼容 OpenAI 格式的 ChatOpenAI 实例化)
    evaluator_llm = ChatOpenAI(
        model="deepseek-v4-flash", # 使用 deepseek-v4-flash 节点
        openai_api_key=DEEPSEEK_API_KEY,
        openai_api_base=DEEPSEEK_BASE_URL,
        temperature=0.0,       # 评估需要高度一致性，温度设为 0
    )

    # 3. 将 DeepSeek 绑定到需要 LLM 的各个指标中
    metrics = [faithfulness, answer_relevancy, context_precision, context_recall]
    for metric in metrics:
        metric.llm = evaluator_llm

    print("---- dataset ----", dataset)

    # 4. 评估
    score = evaluate(
        dataset,
        metrics=metrics,
        llm=evaluator_llm,   # ← 必须指定 LLM
        embeddings=OllamaEmbeddings(
            model="bge-m3",                # 和你现在用的一致
            base_url="http://127.0.0.1:11434",  # Ollama 地址
        ),
        batch_size=4,  
    )

    print("评估得分：", score)

def eval_rag():
    # read_eval_results()
    read_test_questions("0.7")


eval_rag()