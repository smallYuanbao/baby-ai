import traceback

"""
Skills — 将 Agent 的核心能力封装为可插拔的 Skill 模块

每个 Skill 的六部分契约：
  1. 身份        — name + description：LLM 据此判断什么时候调用
  2. 接口        — input_schema()：定义参数；to_tool()：转成 OpenAI FC 格式
  3. 执行        — execute(**kwargs)：核心逻辑
  4. 生命周期    — setup() / teardown()：注入依赖、清理资源
  5. 降级        — fallback(error, **kwargs)：执行失败时的兜底
  6. 约束        — constraints：什么情况下不该用、有什么前置依赖
"""

# ============================================================
# Skill 基类
# ============================================================

class BaseSkill:
    """所有 Skill 的基类，定义六部分完整契约"""

    # ── 1. 身份 ──
    name: str = ""
    description: str = ""

    # ── 6. 约束 ──
    constraints: str = ""

    # ── 2. 接口：参数定义 ──
    def input_schema(self) -> dict:
        """返回 JSON Schema 格式的参数定义"""
        return {"type": "object", "properties": {}, "required": []}

    # ── 2. 接口：转 OpenAI FC 格式 ──
    def to_tool(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema(),
            },
        }

    # ── 3. 执行 ──
    def execute(self, **kwargs):
        raise NotImplementedError

    # ── 4. 生命周期 ──
    def setup(self, **deps):
        """初始化：注入外部依赖（如 MCP client）"""
        pass

    def teardown(self):
        """清理资源"""
        pass

    # ── 5. 降级 ──
    def fallback(self, error: Exception, **kwargs):
        """执行失败时的兜底，子类可以覆盖"""
        return f"[{self.name}] 执行失败: {error}"

    # ── 安全执行（内部自动调 execute + fallback）──
    def run(self, **kwargs):
        """带降级的执行：先调 execute()，失败了走 fallback()"""
        try:
            return self.execute(**kwargs)
        except Exception as e:
            traceback.print_exc()
            return self.fallback(e, **kwargs)