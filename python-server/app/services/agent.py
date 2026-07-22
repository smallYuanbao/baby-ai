import json

from app.services.llm import deepseek_client
from app.services.tools import get_weather, WEATHER_TOOL
from app.models.chat import ChatMessage

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
        model="deepseek-chat",
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
    print("---- response ----")
    print(json.dumps(response_dict, ensure_ascii=False, indent=2))

    if response.choices[0].message.tool_calls:
        # LLM 说“我需要调工具”，拿到工具调用信息
        tool_call = response.choices[0].message.tool_calls[0]
        tool_name = tool_call.function.name
        tool_args = json.loads(tool_call.function.arguments)

        print("-----  tool_args -----")
        print(tool_args)

        # 执行工具
        tool_func = TOOL_MAP[tool_name]
        tool_result = tool_func(**tool_args)

        print("---- tool_result ----")
        print(tool_result)

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
            model="deepseek-chat",
            messages=messages,
            temperature=0.7,
            max_tokens=1000
        )

        print("---- final_response ----")
        print(final_response)
        return final_response.choices[0].message.content
    
    return response.choices[0].message.content


# 用户消息 → 拼入ReAct格式的System Prompt
#     ↓
# while 循环次数 < 最大限制（如5次）:
#     调LLM，让它按 Thought/Action/Observation 格式输出
#     ↓
#     如果LLM输出包含 "Final Answer":
#         提取最终回答，结束循环
#     ↓
#     如果LLM输出包含 "Action":
#         解析工具名和参数 → 执行工具 → 把结果作为 Observation 追加到消息
#     ↓
#     如果LLM输出不包含以上两种:
#         可能是格式错误，重试或退出

SYSTEM_PROMPT = """你是一个严谨的数据查询与任务执行助手。

工作原则：
1. 凡是需要实时数据（天气、新闻、股价）或超出你知识截止日期（2025年5月）的问题，必须调用函数获取，禁止凭记忆编造。
2. 如果函数返回的数据不足以回答用户（如数据为空或只包含部分信息），请再次调用函数补充，直到信息完整。
3. 若同一函数连续调用 2 次仍返回错误或空数据，请停止尝试，并直接告知用户：“暂时无法获取数据，请稍后重试。”

输出规范：
- 需要调用工具时，直接输出 tool_calls 指令。
- 需要回答用户时，直接输出自然语言文本，不需要添加任何额外前缀（如“Final Answer:”）。"""

MAX_STEPS = 5

def react_agent_chat(user_message: str):
    messages = []

    messages.append(ChatMessage(role="system", content=SYSTEM_PROMPT))

    messages.append(ChatMessage(role="user", content=user_message))


    for step in range(MAX_STEPS):

        response = deepseek_client.chat.completions.create(
            model="deepseek-chat",
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
        print("---- response ----")
        print(json.dumps(response_dict, ensure_ascii=False, indent=2))

        response_message = response.choices[0].message
        
        if response_message.tool_calls:
            # LLM 说“我需要调工具”，拿到工具调用信息
            tool_call = response.choices[0].message.tool_calls[0]
            tool_name = tool_call.function.name
            tool_args = json.loads(tool_call.function.arguments)

            print("-----  tool_args -----")
            print(tool_args)

            # 执行工具
            tool_func = TOOL_MAP[tool_name]
            tool_result = tool_func(**tool_args)

            print("---- tool_result ----")
            print(tool_result)

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

