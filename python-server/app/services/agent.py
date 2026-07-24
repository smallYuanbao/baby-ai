from contextlib import AsyncExitStack
import json
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

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


class MCPClient:
    """
    MCP 客户端 — 通过独立后台线程管理 MCP Server 连接

    ===== 为什么用独立线程 + 独立事件循环？=====

    MCP SDK 内部用 anyio 管理异步上下文。FastAPI/uvicorn 的事件循环
    和 anyio 的 cancel scope 有兼容冲突（详见 anyio 4.x 的 "Attempted to
    exit cancel scope in a different task" 问题）。

    解决方式：在后台线程里跑一个完全独立的事件循环，MCP 所有的
    enter/exit 都在这一个线程里完成，永远不会跨 task。

    ===== 数据流 =====

    mcp-server/weather_server.py（工具定义 + 实现）
         ↑ stdio 通信（子进程 stdin/stdout）
    MCPClient（本类，后台线程）
         ↓ 跨线程调用（run_coroutine_threadsafe）
    agent_chat_mcp()（FastAPI 请求线程）
         ↓ OpenAI function calling 格式
    DeepSeek LLM → tool_calls → MCPClient.call_tool() → 拿到结果 → 再调 LLM
    """

    def __init__(self):
        # ---- 连接相关 ----
        self.session: ClientSession | None = None  # MCP 协议会话
        self.read = None    # stdin 读取流
        self.write = None   # stdout 写入流

        # ---- 工具相关 ----
        self.tools: list = []  # MCP Server 暴露的工具列表

        # ---- 内部管理 ----
        self._server_script = None       # 服务器脚本路径
        self._stdio_ctx = None           # stdio_client 上下文（__aexit__ 清理用）
        self._session_ctx = None         # ClientSession 上下文
        self._loop_thread = None         # 后台线程引用

    # ============================================================
    # 连接：在后台线程建立 stdio 通道 → 发现工具
    # ============================================================

    def connect_sync(self, server_script_path: str):
        """
        启动 MCP Server 子进程，建立 stdio 连接，发现工具。

        全部在独立线程 + 独立事件循环中完成，和 FastAPI 的事件循环隔离。
        """
        import sys
        import os
        import asyncio
        import threading

        self._server_script = server_script_path

        # ---- 内部：在 MCP 专用事件循环中执行的连接逻辑 ----
        async def _connect():
            # ① 构造子进程启动参数（用当前 Python 执行天气 Server 脚本）
            server_params = StdioServerParameters(
                command=sys.executable,
                args=[os.path.abspath(server_script_path)],
                env=None,
                cwd=os.path.dirname(os.path.abspath(server_script_path)),
            )

            # ② 启动子进程 → 建立 stdio 通道
            #    stdio_client 用 @asynccontextmanager，返回 (read_stream, write_stream)
            #    read_stream  = 从子进程 stdout 读取数据
            #    write_stream = 向子进程 stdin 写入数据
            self._stdio_ctx = stdio_client(server_params)
            self.read, self.write = await self._stdio_ctx.__aenter__()

            # ③ 在 stdio 通道上建立 MCP 协议会话
            #    ClientSession 封装了 JSON-RPC 通信细节
            self._session_ctx = ClientSession(self.read, self.write)
            self.session = await self._session_ctx.__aenter__()

            # ④ MCP 握手：initialize + list_tools
            #    initialize() = MCP 协议的握手（协商协议版本和能力）
            #    list_tools() = 向 Server 请求工具列表
            await self.session.initialize()
            response = await self.session.list_tools()
            self.tools = response.tools
            print("[MCP] 已连接，可用工具:", json.dumps([t.model_dump()["name"] for t in self.tools], ensure_ascii=False, indent=2))

        # ---- 启动后台线程，创建独立事件循环 ----
        def _run_loop():
            self._loop = asyncio.new_event_loop()     # 新建独立事件循环，存下来给 call_tool 用
            asyncio.set_event_loop(self._loop)         # 设为当前线程默认
            self._loop.run_until_complete(_connect())  # 跑连接逻辑
            self._loop.run_forever()                   # 保持循环不结束，session 一直有效

        t = threading.Thread(target=_run_loop, daemon=True)
        t.start()
        self._loop_thread = t

        # ---- 等后台线程完成连接 + 工具列表就绪（轮询，最多等 5 秒）----
        import time
        for _ in range(50):
            if self.tools:  # 确认工具列表已拿到，不只是 session 创建了
                break
            time.sleep(0.1)

    # ============================================================
    # 工具格式转换：MCP 格式 → OpenAI function calling 格式
    # ============================================================

    def get_tools_as_fc_format(self) -> list[dict]:
        """
        将 MCP Server 的工具列表转为 OpenAI function calling 格式。

        MCP 格式（inputSchema）:
          { "name": "get_weather", "parameters": {"type": "object", ...} }

        OpenAI 格式（function）:
          { "type": "function", "function": { "name": "...", "parameters": {...} } }
        """
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description or "",
                    "parameters": tool.inputSchema,
                },
            }
            for tool in self.tools
        ]

    # ============================================================
    # 工具调用：跨线程把请求发给 MCP 后台线程执行
    # ============================================================

    def call_tool(self, tool_name: str, args: dict) -> str:
        """
        调用 MCP 工具，返回执行结果的文本。

        ===== 为什么需要跨线程？=====
        self.session 活在后台线程的事件循环里，不能直接从 FastAPI
        请求线程调它的 async 方法。必须用 run_coroutine_threadsafe
        把 async 任务投递到后台事件循环里执行，再取回结果。
        """
        import asyncio

        async def _call():
            result = await self.session.call_tool(tool_name, args)
            # MCP 返回格式: {"content": [{"type": "text", "text": "..."}]}
            return result.content[0].text

        future = asyncio.run_coroutine_threadsafe(_call(), self._loop)
        return future.result(timeout=30)

    # ============================================================
    # 清理
    # ============================================================

    def cleanup(self):
        """daemon 线程随进程退出自动回收，无需显式清理"""
        pass


async def agent_chat_mcp(user_message: str, mcp_client: MCPClient) -> str:
    # 1. 把 MCP 工具列表转成 FC 格式
    tools = mcp_client.get_tools_as_fc_format()

    # 2. 第一次调 LLM：决策（注入当前日期，LLM 不知道今天几号）
    from datetime import date
    today_str = date.today().isoformat()  # → "2026-07-24"
    response = deepseek_client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": f"今天是 {today_str}。"},
            {"role": "user", "content": user_message},
        ],
        tools=tools,
        temperature=0.7
    )

    msg = response.choices[0].message

    print("-----  msg -----", msg)

    if msg.tool_calls:
        # 3. LLM 要求调工具 → 通过 MCP 执行
        tool_call = msg.tool_calls[0]
        args = json.loads(tool_call.function.arguments)


        print("------ args ------")
        print(args)
        result = mcp_client.call_tool(tool_call.function.name, args)

        print("----- result -----")
        print(result)
        # 4. 把结果还给 LLM 生成最终回答
        final_response = deepseek_client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                {"role": "tool", "tool_call_id": tool_call.id, "content": result}
            ],
            temperature=0.7
        )
        return final_response.choices[0].message.content
    return response.choices[0].message.content