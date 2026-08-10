from contextlib import AsyncExitStack
import json
from typing import Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.services.llm import call_deepseek, deepseek_client
from app.services.tools import get_weather, WEATHER_TOOL
from app.models.chat import ChatHistoryEntry, ChatMessage, Reference
from app.services.rag.retriever import hybrid_search
from app.services.rag.reranker import rerank
from app.services.chat_service import _build_messages
from app.services.pipeline.intent import IntentResult, route_intent
from app.services.pipeline.rewrite import rewrite_query
from app.services.pipeline.session import get_history
from app.skills.weather import WeatherSkill
from app.skills import get_skill_by_name
from app.services.agent.mcp_client import MCPClient
from app.services.agent.reflection import review_agent
from app.services.pipeline.security import detect_injection, sanitize_input
from app.core.cost_tracker import cost_tracker
from app.services.memory.user_profile import extract_profile, get_profile, profile_to_prompt, save_profile
from app.utils.logger import logger


MAX_STEPS = 5

# 注册所有可用工具
AVAILABLE_TOOLS = [WEATHER_TOOL]

# 工具名 → 实际函数的映射
TOOL_MAP = {
    "get_weather": get_weather
}

def generation_agent(messages: list[ChatMessage]) -> str:
    """
    回答 Agent：负责基于检索结果生成回答。
    
    这个 Agent 只做一件事——拿到用户问题和检索文档，拼 Prompt，调 LLM 生成回答。
    它不需要知道文档是怎么来的，也不需要检查回答是否正确。
    """

    answer = call_deepseek(messages)
    
    return answer


def _execute_tool(tool_name: str, tool_args: dict, mcp_client: MCPClient):
    # 1. Skill 优先
    skill = get_skill_by_name(tool_name) if SKILLS else None
    if skill:
        return skill.execute(**tool_args)

    # 2. 本地 Tool 兜底
    if tool_name in TOOL_MAP:
        return TOOL_MAP[tool_name](**tool_args)

    # 3. MCP 最后
    if mcp_client:
        return mcp_client.call_tool(tool_name, tool_args)

    return f"未找到工具或技能: {tool_name}"
    
    

def check_and_call_tool(user_message: str, mcp_client: MCPClient):
    """
    工具决策核心：先用单步 Function Calling 判断是否需要工具。
    如果 LLM 返回的 finish_reason 是 tool_calls，则走 ReAct 多步循环。
    """

    # 2. 工具决策——从 SKILLS 列表构建工具描述
    tools = [skill.to_tool() for skill in SKILLS]

    # tools = _get_available_tools(mcp_client)

    if not tools:
        return False, ""

    messages = []

    messages.append(ChatMessage(role="user", content=user_message))
    tool_results = []
    # ---- 2. ReAct 循环 ----
    for step in range(MAX_STEPS):
        response = deepseek_client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=messages,
            tools=tools,
            temperature=0.7,
            max_tokens=1000
        )

        finish_reason = response.choices[0].finish_reason
        msg = response.choices[0].message

        if finish_reason == "stop":
            # LLM 认为不需要更多工具了，结束循环
            break

        elif finish_reason == "tool_calls":
            # LLM 要求调工具 → 并行执行本轮的多个 tool_calls
            messages.append(msg)

            # ---- 并行执行（ThreadPoolExecutor，同步 call_tool 也能并行）----
            from concurrent.futures import ThreadPoolExecutor, as_completed

            with ThreadPoolExecutor(max_workers=len(msg.tool_calls)) as executor:
                # 提交所有任务
                future_to_tc = {}
                for tc in msg.tool_calls:
                    tool_name = tc.function.name
                    tool_args = json.loads(tc.function.arguments)
                    future = executor.submit(
                        _execute_tool, tool_name, tool_args, mcp_client
                    )
                    future_to_tc[future] = tc

                # 收集结果（哪个先跑完就先处理，不破坏关联关系）
                for future in as_completed(future_to_tc):
                    tc = future_to_tc[future]
                    result = future.result()
                    tool_results.append({tc.function.name: result})

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    })

            # tool 结果全部追完后回到循环顶部，LLM 看到结果决定是否继续
        else:
            # length / content_filter → 安全退出
            break

    # ---- 3. 返回工具数据 ----
    if tool_results:
        return True, json.dumps(tool_results, ensure_ascii=False, indent=2)
    return False, ""


def get_query_rewrite(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
) ->  tuple[str, list[ChatHistoryEntry]]:
    """
    查询改写。
    
    Returns:
        message：查询改写后的message
    """
    # 1. 取服务端历史（如果客户端没传，用服务端的）
    server_history = get_history(session_id)
    history = client_history if client_history else server_history

    # 2. 改写
    rewrite_result = rewrite_query(user_message, history)
    message = rewrite_result.wasRewritten and rewrite_result.rewrittenQuery or user_message

    return message, history

def rag_and_rerank(intent_result: IntentResult, message: str ) -> tuple[list[str], list[Reference]]:
    # 4. RAG 检索（后）— emergency 跳过
    if intent_result.intent == "emergency":
        context_docs = []
        references = []
    else:
        results = hybrid_search(message, alpha=0.7, top_k=10)

        # RRF 混合检索 → 多召回一些候选
        # results = hybrid_search_rrf(message, top_k=10)

        # 精排：BGE → DeepSeek → 原始距离排序
        ranked_result = rerank(message, results, top_k=5)

        # 文本列表（给 buildPrompt 拼 prompt 用）
        context_docs = [d["text"] for d in ranked_result["rankedDocuments"]]

        # 结构化引用（给前端展示，包含 id + text）
        references = [
            Reference(id=d["id"] or "", text=d["text"])
            for d in ranked_result["rankedDocuments"]
        ]
    return context_docs, references

def _format_tool_data(tool_data: str) -> str:
    """尝试解析工具数据为人类可读格式，失败则原样返回"""
    try:
        data = json.loads(tool_data)
        # 提取天气数据（兼容两种格式：MCP 格式化字符串 / JSON dict）
        if isinstance(data, list) and len(data) > 0:
            item = list(data[0].values())[0] if isinstance(data[0], dict) else data[0]
        else:
            item = data.get("get_weather", data) if isinstance(data, dict) else data

        if isinstance(item, str):
            # MCP 返回的字符串可能已含前缀，避免重复
            return item if item.startswith("【") else f"【实时天气数据】\n{item}"
        if isinstance(item, dict):
            return (
                f"【实时天气数据】\n"
                f"城市：{item.get('city', '未知')}\n"
                f"日期：{item.get('date', '未知')}\n"
                f"最高温：{item.get('max_temp', '?')}℃\n"
                f"最低温：{item.get('min_temp', '?')}℃\n"
                f"天气：{item.get('weather_desc', '未知')}\n"
                f"湿度：{item.get('humidity', '未知')}%"
            )
        return tool_data
    except (json.JSONDecodeError, IndexError, KeyError, AttributeError):
        return tool_data

# 注册所有可用 Skills
SKILLS = [WeatherSkill()]  # 未来新增工具只需在这里加一行

def unified_agent(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
    mcp_client: MCPClient
):
    """
    统一 Agent 入口：安全过滤 → 预处理 → 工具决策 → RAG检索 → 生成 → 审核
    """
    # 0. 安全过滤（新增！）
    user_message = sanitize_input(user_message)
    if detect_injection(user_message):
        return {"answer": "抱歉，检测到异常输入，请重新提问育儿相关问题。",
                "references": [], "category": "blocked"}

    # 0.5 缓存检查（新增）
    cached = cost_tracker.get_cache(user_message)

    if cached:
        return { "answer": cached,  "references": [], "category": "cache_hit" }

    # 0. 检索用户档案（长期记忆）
    profile = get_profile(session_id)
    profile_text = profile_to_prompt(profile) if profile else ""

    # 1. 预处理（只在检索环节使用）
    message, history = get_query_rewrite(user_message, session_id, client_history)
    # 意图路由
    intent_result = route_intent(message)

    # 2. 工具决策：用 Function Calling 判断是否需要外部工具（天气、搜索等）
    need_tool, tool_data = check_and_call_tool(message, mcp_client)

    # ========== 3. RAG 检索：领域知识（和工具并行，不做 if/else 二选一）==========
    references, context_docs = rag_and_rerank(intent_result, message)

    # ========== 4. 合并上下文：工具数据（实时事实）排最前面，RAG（领域知识）排后面 ==========
    if tool_data:
        # 把工具返回的 JSON 转成人类可读的天气描述
        tool_text = _format_tool_data(tool_data)
        context_docs.insert(0, Reference(id="tool_data", text=tool_text))

    # ========== 5. 生成回答 ==========
    # _build_messages 需要 list[str]，从 Reference 中提取 text
    doc_texts = [d.text if isinstance(d, Reference) else d for d in context_docs]
    messages = _build_messages(message, doc_texts, history, intent_result)

    logger.debug("----- messages -----\n%s", messages)

    initial_answer = generation_agent(messages)

    # ========== 6. 审核反思（用原始 user_message！）==========
    final_answer = review_agent(user_message, initial_answer)

    # 最终回答存入缓存
    cost_tracker.set_cache(user_message, final_answer)

    # 提取并保存用户档案（异步不阻塞，失败不影响主流程）
    try:
        new_profile = extract_profile(user_message, final_answer)
        if new_profile:
            # 合并已有档案（新信息覆盖旧信息）
            if profile:
                profile.update(new_profile)
            else:
                profile = new_profile
            save_profile(session_id, profile)
    except Exception as e:
        logger.error("[用户档案] 提取失败: %s", e)
    

    # ========== 7. 返回结果 ==========
    return {
        "answer": final_answer,
        "references": references,
        "category": intent_result.intent,
    }
