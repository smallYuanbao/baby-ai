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
def agent_chat_mcp(user_message: str, mcp_client: MCPClient) -> str:
    # 1. 把 MCP 工具列表转成 FC 格式
    tools = mcp_client.get_tools_as_fc_format()

    # 2. 第一次调 LLM：决策（注入当前日期，LLM 不知道今天几号）
    from datetime import date
    today_str = date.today().isoformat()  # → "2026-07-24"
    response = deepseek_client.chat.completions.create(
        model="deepseek-v4-flash",
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
            model="deepseek-v4-flash",
            messages=[
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                {"role": "tool", "tool_call_id": tool_call.id, "content": result}
            ],
            temperature=0.7
        )
        return final_response.choices[0].message.content
    return response.choices[0].message.content


# ============================================================
# 多 Agent 协作流水线
# ============================================================



def agent_chat_mcp(user_message: str, mcp_client: "MCPClient") -> str:
    """单次 MCP 工具调用（非 ReAct，一步完成）"""
    import json
    from datetime import date

    tools = mcp_client.get_tools_as_fc_format()
    today_str = date.today().isoformat()

    response = deepseek_client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=[
            {"role": "system", "content": f"今天是 {today_str}。"},
            {"role": "user", "content": user_message},
        ],
        tools=tools,
        temperature=0.7,
    )

    msg = response.choices[0].message
    if msg.tool_calls:
        tool_call = msg.tool_calls[0]
        args = json.loads(tool_call.function.arguments)
        result = mcp_client.call_tool(tool_call.function.name, args)

        final_response = deepseek_client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=[
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": None, "tool_calls": [tool_call]},
                {"role": "tool", "tool_call_id": tool_call.id, "content": result},
            ],
            temperature=0.7,
        )
        return final_response.choices[0].message.content
    return msg.content
