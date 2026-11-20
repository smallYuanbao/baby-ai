# scripts/langgraph_demo.py

from typing import TypedDict
from langgraph.graph import StateGraph, END

# ==================== 1. 定义全局状态 ====================
class AgentState(TypedDict):
    query: str
    retrieved_docs: list[str]
    draft: str
    final_answer: str
    review_passed: bool
    retry_count: int  # 重试计数器，防止无限循环

# ==================== 2. 定义三个节点函数 ====================

def retrieval_node(state: AgentState) -> dict:
    """检索 Agent：从知识库中检索相关文档"""
    # 模拟检索（实际应调用你的 hybrid_search）
    query = state["query"]
    docs = [
        f"【文档1】关于'{query}'的育儿指南第一部分...",
        f"【文档2】关于'{query}'的育儿指南第二部分..."
    ]
    print(f"[检索] 为 '{query}' 找到 {len(docs)} 份文档")
    return {"retrieved_docs": docs}

def generation_node(state: AgentState) -> dict:
    """生成 Agent：基于检索结果生成初步回答"""
    query = state["query"]
    docs = state["retrieved_docs"]
    retry = state.get("retry_count", 0)

    # 模拟生成（第一次生成较短，触发重试；第二次生成更长）
    if retry == 0:
        draft = f"关于'{query}'的简短回答草案。"
    else:
        draft = f"关于'{query}'的详细回答草案。基于{len(docs)}份文档，我提供以下建议：首先...其次...最后..."

    print(f"[生成] 第{retry + 1}次生成，草案长度: {len(draft)}")
    return {"draft": draft, "retry_count": retry + 1}

def review_node(state: AgentState) -> dict:
    """审核 Agent：检查回答是否合格"""
    draft = state["draft"]
    retry = state.get("retry_count", 0)

    # 模拟审核：草案长度超过 30 字算通过
    passed = len(draft) > 30
    print(f"[审核] 草案长度: {len(draft)}, 是否通过: {passed}")

    if passed:
        return {"final_answer": draft, "review_passed": True}
    else:
        return {"final_answer": f"审核未通过(第{retry+1}次)，草案过短", "review_passed": False}

# ==================== 3. 条件边：决定审核后去哪 ====================

def should_continue(state: AgentState) -> str:
    """判断审核后是否继续循环"""
    if state["review_passed"]:
        print("[路由] 审核通过 → 结束")
        return "end"

    # 最多重试 2 次
    if state.get("retry_count", 0) >= 2:
        print("[路由] 重试次数用尽 → 强制结束")
        return "end"

    print("[路由] 审核不通过 → 重新生成")
    return "generation"

# ==================== 4. 构建状态图 ====================

def build_graph():
    graph = StateGraph(AgentState)

    # 添加节点
    graph.add_node("retrieval", retrieval_node)
    graph.add_node("generation", generation_node)
    graph.add_node("review", review_node)

    # 设置入口
    graph.set_entry_point("retrieval")

    # 固定边
    graph.add_edge("retrieval", "generation")
    graph.add_edge("generation", "review")

    # 条件边：审核 → 继续生成 或 结束
    graph.add_conditional_edges("review", should_continue, {
        "generation": "generation",
        "end": END
    })

    return graph.compile()

# ==================== 5. 运行 ====================

if __name__ == "__main__":
    app = build_graph()

    print("=" * 50)
    print("测试：多Agent协作（检索→生成→审核）")
    print("=" * 50)

    result = app.invoke({
        "query": "宝宝发烧怎么办",
        "retry_count": 0
    })

    print("\n" + "=" * 50)
    print(f"最终回答: {result['final_answer']}")
    print(f"审核结果: {'通过' if result['review_passed'] else '不通过'}")