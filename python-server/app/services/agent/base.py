from contextlib import AsyncExitStack
import json
from typing import Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.services.llm import call_deepseek, deepseek_client
from app.services.tools import get_weather, WEATHER_TOOL
from app.models.chat import ChatHistoryEntry, ChatMessage, Reference
from app.services.chat_service import _build_messages
from app.services.rag.retriever import hybrid_search
from app.services.rag.reranker import rerank
from app.services.pipeline.intent import IntentResult, route_intent
from app.services.pipeline.rewrite import rewrite_query
from app.services.pipeline.session import get_history
from app.skills.weather import WeatherSkill
from app.skills import get_skill_by_name
from app.utils.logger import logger
# generation_agent / review_agent 在函数内懒加载，避免循环导入



# 注册所有可用工具
AVAILABLE_TOOLS = [WEATHER_TOOL]

# 工具名 → 实际函数的映射
TOOL_MAP = {
    "get_weather": get_weather
}

def agent_chat(user_message: str) -> str:
    """
    Agent 决策循环：
    1. 把用户消息和可用工具列表发给 LLM
    2. 如果 LLM 决定调工具 → 执行工具 → 把结果还给 LLM → 生成最终回答
    3. 如果 LLM 不需要调工具 → 直接返回回答
    """

    messages = [{"role": "user", "content": user_message}]

    # 第一次调 LLM：让它决定是否需要调工具
    response = deepseek_client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=messages,
        tools=AVAILABLE_TOOLS,
        temperature=0.7,
        max_tokens=500
    )
    # 把 SDK 返回的 response 对象转成 dict，方便调试查看
    response_dict = {
        "id": response.id,
        "model": response.model,
        "choices": [
            {
                "index": choice.index,
                "finish_reason": choice.finish_reason,
                "message": {
                    "role": choice.message.role,
                    "content": choice.message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in (choice.message.tool_calls or [])
                    ] if choice.message.tool_calls else None,
                },
            }
            for choice in response.choices
        ],
        "usage": {
            "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
            "completion_tokens": response.usage.completion_tokens if response.usage else 0,
            "total_tokens": response.usage.total_tokens if response.usage else 0,
        } if response.usage else None,
    }
    logger.debug("---- response ----\n%s", json.dumps(response_dict, ensure_ascii=False, indent=2))

    if response.choices[0].message.tool_calls:
        # LLM 说"我需要调工具"，拿到工具调用信息
        tool_call = response.choices[0].message.tool_calls[0]
        tool_name = tool_call.function.name
        tool_args = json.loads(tool_call.function.arguments)

        logger.debug("-----  tool_args -----\n%s", tool_args)

        # 执行工具
        tool_func = TOOL_MAP[tool_name]
        tool_result = tool_func(**tool_args)

        logger.debug("---- tool_result ----\n%s", tool_result)

        # 把工具返回结果告诉 LLM，让它继续生成回答
        messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [tool_call]
        })
        messages.append({
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": json.dumps(tool_result, ensure_ascii=False)
        })

        # 第二次调 LLM：结合工具结果生成最终回答
        final_response = deepseek_client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=messages,
            temperature=0.7,
            max_tokens=1000
        )

        logger.debug("---- final_response ----\n%s", final_response)
        return final_response.choices[0].message.content
    
    return response.choices[0].message.content


SYSTEM_PROMPT = """你是一个严谨的数据查询与任务执行助手。

工作原则：
1. 凡是需要实时数据（天气、新闻、股价）或超出你知识截止日期（2025年5月）的问题，必须调用函数获取，禁止凭记忆编造。
2. 如果函数返回的数据不足以回答用户（如数据为空或只包含部分信息），请再次调用函数补充，直到信息完整。
3. 若同一函数连续调用 2 次仍返回错误或空数据，请停止尝试，并直接告知用户："暂时无法获取数据，请稍后重试。"

输出规范：
- 需要调用工具时，直接输出 tool_calls 指令。
- 需要回答用户时，直接输出自然语言文本，不需要添加任何额外前缀（如"Final Answer:"）。"""

MAX_STEPS = 5

# ReAct 模式

def react_agent_chat(user_message: str):
    messages = []

    messages.append(ChatMessage(role="system", content=SYSTEM_PROMPT))

    messages.append(ChatMessage(role="user", content=user_message))


    for step in range(MAX_STEPS):

        response = deepseek_client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=messages,
            tools=AVAILABLE_TOOLS,
            temperature=0.7,
            max_tokens=1000
        )

        response_dict = {
            "id": response.id,
            "model": response.model,
            "choices": [
                {
                    "index": choice.index,
                    "finish_reason": choice.finish_reason,
                    "message": {
                        "role": choice.message.role,
                        "content": choice.message.content,
                        "tool_calls": [
                            {
                                "id": tc.id,
                                "function": {
                                    "name": tc.function.name,
                                    "arguments": tc.function.arguments,
                                },
                            }
                            for tc in (choice.message.tool_calls or [])
                        ] if choice.message.tool_calls else None,
                    },
                }
                for choice in response.choices
            ],
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            } if response.usage else None,
        }
        logger.debug("---- response ----\n%s", json.dumps(response_dict, ensure_ascii=False, indent=2))

        response_message = response.choices[0].message

        if response_message.tool_calls:
            # LLM 说"我需要调工具"，拿到工具调用信息
            tool_call = response.choices[0].message.tool_calls[0]
            tool_name = tool_call.function.name
            tool_args = json.loads(tool_call.function.arguments)

            logger.debug("-----  tool_args -----\n%s", tool_args)

            # 执行工具
            tool_func = TOOL_MAP[tool_name]
            tool_result = tool_func(**tool_args)

            logger.debug("---- tool_result ----\n%s", tool_result)

            # 把工具返回结果告诉 LLM，让它继续生成回答
            messages.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [tool_call]
            })
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(tool_result, ensure_ascii=False)
            })
             # 循环继续，LLM 看到工具结果后再次决定下一步

        else:
             # 其他情况（如 length 截断、内容过滤），安全退出
            return response.choices[0].message.content or "抱歉，回答生成失败"

    # 超过最大步数，强制退出
    return "抱歉，任务步骤过多，暂时无法完成。请简化您的问题。"

def retrieval_agent(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
) -> tuple[list[ChatMessage], list[Reference]]:
    """
    检索 + 构建 Prompt。
    
    Returns:
        messages:    拼好的完整 messages 数组（可直接传给 LLM）
        context_docs: 只含文本的文档列表（给 buildPrompt 用，保持向后兼容）
        references:   带 id + text 的结构化引用列表（返回给前端展示）

    这个 Agent 只做一件事——拿到用户问题，调混合检索，返回文档列表。
    它不需要知道后续如何处理这些文档。
    """

    # 1. 取服务端历史（如果客户端没传，用服务端的）
    server_history = get_history(session_id)
    history = client_history if client_history else server_history

    # 2. 改写
    rewrite_result = rewrite_query(user_message, history)
    message = rewrite_result.wasRewritten and rewrite_result.rewrittenQuery or user_message

    # 3. 意图路由
    intent_result = route_intent(message)
    logger.info("[意图路由] 类别: %s", intent_result.intent)

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
    
    messages = _build_messages(message, context_docs, history, intent_result)

    return messages, references


def mutil_agent_pipeline(
    user_message: str,
    session_id: str,
    client_history: list[ChatHistoryEntry],
):
   # 预处理（只在检索环节使用）
   messages, references  = retrieval_agent(user_message, session_id, client_history)

   # 懒加载避免循环导入
   from app.services.agent.unified import generation_agent
   from app.services.agent.reflection import review_agent

   # Agent 2：生成（使用重写后的查询，Prompt 更清晰）
   initial_answer = generation_agent(messages)

   # Agent 3：审核（使用原始消息！检查是否真正回答了用户的问题）
   final_answer = review_agent(user_message, initial_answer)

   return  {"answer": final_answer, "references": references}

