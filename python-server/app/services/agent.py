import json

from app.services.llm import deepseek_client
from app.services.tools import get_weather, WEATHER_TOOL

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