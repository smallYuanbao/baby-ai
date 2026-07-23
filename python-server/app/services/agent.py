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


SYSTEM_PROMPT = """你是一个严谨的数据查询与任务执行助手。

工作原则：
1. 凡是需要实时数据（天气、新闻、股价）或超出你知识截止日期（2025年5月）的问题，必须调用函数获取，禁止凭记忆编造。
2. 如果函数返回的数据不足以回答用户（如数据为空或只包含部分信息），请再次调用函数补充，直到信息完整。
3. 若同一函数连续调用 2 次仍返回错误或空数据，请停止尝试，并直接告知用户：“暂时无法获取数据，请稍后重试。”

输出规范：
- 需要调用工具时，直接输出 tool_calls 指令。
- 需要回答用户时，直接输出自然语言文本，不需要添加任何额外前缀（如“Final Answer:”）。"""

MAX_STEPS = 5

# ReAct 模式

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

REFLECTION_PROMPT = """你是一个严格的儿科医学审查专家。你的任务是审查以下AI助手的回答，找出任何可能误导家长的医学错误、遗漏或不严谨之处。

## 审查规则
1. 如果回答完全正确且无遗漏，请输出"审核通过"。
2. 如果存在以下任何问题，必须明确指出并修正：
   - 医学事实错误（如体温阈值、用药剂量、月龄限制）
   - 关键信息遗漏（如只说了“吃药”但没说明具体剂量和间隔）
   - 表述不严谨（如“多喝水”但未说明具体量或频率）
   - 缺乏安全警示（如未提醒某些情况下必须就医）

## 用户问题
{user_message}

## AI 助手的回答
{initial_answer}

## 审查结果
请按以下格式输出：
❌ 发现的问题：
（逐条列出，如果没有问题则输出“无”）

🔧 修正后的完整回答：
（如果审核通过，则输出原回答；否则输出修正后的完整回答）"""

def reflect_and_correct(user_message: str, initial_answer: str) -> str:
    """让LLM反思自己的回答，指出问题并修正"""
    prompt = REFLECTION_PROMPT.format(
        user_message=user_message,
        initial_answer=initial_answer
    )

    response = deepseek_client.chat.completions.create(
        model="deepseek-chat",
        messages=[{"role": "user", "content": prompt}],
        temperature=0,  # 审查必须稳定
        max_tokens=1000
    )

    review = response.choices[0].message.content

    print("------ review ------")

    print(review)

    if "审核通过" in review:
        return initial_answer
    else:
        return review  # 包含修正后的完整回答

def react_agent_with_reflection(user_message: str) -> str:
    """ReAct Agent + Self-Reflection"""
    # 1. 先用 ReAct 拿到初步回答
    initial_answer = react_agent_chat(user_message)

    # 2. 再反思修正
    final_answer = reflect_and_correct(user_message, initial_answer)
    return final_answer
