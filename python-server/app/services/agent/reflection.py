from contextlib import AsyncExitStack
import json
from typing import Optional
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from app.services.llm import call_deepseek, deepseek_client
from app.services.tools import get_weather, WEATHER_TOOL
from app.models.chat import ChatHistoryEntry, ChatMessage, Reference
from app.services.chat_service import _build_messages
from app.skills.weather import WeatherSkill
from app.skills import get_skill_by_name



# 注册所有可用工具
AVAILABLE_TOOLS = [WEATHER_TOOL]

# 工具名 → 实际函数的映射
TOOL_MAP = {
    "get_weather": get_weather
}

REFLECTION_PROMPT = """你是一个严格的儿科医学审查专家。你的任务是审查以下AI助手的回答，找出任何可能误导家长的医学错误、遗漏或不严谨之处。

## 审查规则
1. 如果回答完全正确且无遗漏，请输出"审核通过"。
2. 如果存在以下任何问题，必须明确指出并修正：
   - 医学事实错误（如体温阈值、用药剂量、月龄限制）
   - 关键信息遗漏（如只说了"吃药"但没说明具体剂量和间隔）
   - 表述不严谨（如"多喝水"但未说明具体量或频率）
   - 缺乏安全警示（如未提醒某些情况下必须就医）

## 重要提示
- 回答中标注为【实时天气数据】的内容来自真实的天气 API 调用，不是模型编造的，请不要标记为"编造"或"虚构"。
- 如果天气数据格式正确（城市、温度、湿度），请直接信任并使用。

## 用户问题
{user_message}

## AI 助手的回答
{initial_answer}

## 审查结果
请按以下格式输出：
❌ 发现的问题：
（逐条列出，如果没有问题则输出"无"）

🔧 修正后的完整回答：
（如果审核通过，则输出原回答；否则输出修正后的完整回答）"""

def reflect_and_correct(user_message: str, initial_answer: str) -> str:
    """让LLM反思自己的回答，指出问题并修正"""
    prompt = REFLECTION_PROMPT.format(
        user_message=user_message,
        initial_answer=initial_answer
    )

    response = deepseek_client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=[{"role": "user", "content": prompt}],
        temperature=0,  # 审查必须稳定
        max_tokens=4000  # 审查输出 = 问题列表 + 完整回答，需要较大 token 空间
    )

    review = response.choices[0].message.content
    finish = response.choices[0].finish_reason
    usage = response.usage

    print(f"------ review (finish_reason={finish}, tokens={usage.completion_tokens if usage else '?'}) ------")

    print(review)

    if "审核通过" in review:
        return initial_answer
    else:
        return review  # 包含修正后的完整回答

def react_agent_with_reflection(user_message: str) -> str:
    """ReAct Agent + Self-Reflection"""
    from app.services.agent.base import react_agent_chat  # 懒加载避免循环导入

    # 1. 先用 ReAct 拿到初步回答
    initial_answer = react_agent_chat(user_message)

    # 2. 再反思修正
    final_answer = reflect_and_correct(user_message, initial_answer)
    return final_answer

def review_agent(query: str, answer: str) -> str:
    """
    审核 Agent：负责反思和修正回答。
    
    这个 Agent 只做一件事——拿到用户问题和初步回答，用反思机制检查并修正。
    它是回答质量的最后一道防线。
    """
    final_answer = reflect_and_correct(query, answer)
    return final_answer

