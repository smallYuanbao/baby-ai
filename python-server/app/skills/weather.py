# ============================================================
# 3. 天气 Skill — MCP 代理层
# ============================================================

from app.skills.base import BaseSkill


class WeatherSkill(BaseSkill):

    name = "get_weather"
    description = (
        "获取指定城市指定日期的天气，每次返回单日数据。"
        "支持今天、明天、后天。如需多天请分别调用。"
        "用户问题涉及天气、温度、是否适合出门等，应优先调用此技能。"
    )
    constraints = (
        "用户已明确说出温度（如'今天35度'）时可不调用"
    )

    _mcp_client: object | None = None

    def setup(self, mcp_client=None, **deps):
        """注入 MCP 客户端"""
        if mcp_client:
            self._mcp_client = mcp_client

    def input_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称"},
                "date": {"type": "string", "description": "日期：今天/明天/后天"},
            },
            "required": ["city", "date"],
        }

    def execute(self, **kwargs) -> str:
        """args 透传给 MCP，Skill 不关心具体参数名"""
        city = kwargs.get("city", "北京")
        date = kwargs.get("date", "今天")

        # 1. 优先走 MCP
        if self._mcp_client:
            try:
                return self._mcp_client.call_tool(self.name, kwargs)
            except Exception:
                pass

        # 2. MCP 不可用 → 本地 API 兜底
        import requests
        date_map = {"今天": 0, "明天": 1, "后天": 2}
        offset = date_map.get(date, 0)

        resp = requests.get(f"https://wttr.in/{city}?format=j1", timeout=10)
        resp.raise_for_status()
        forecast = resp.json()["weather"][offset]

        return (
            f"【实时天气数据】\n"
            f"城市：{city}\n日期：{forecast['date']}\n"
            f"最高温：{forecast['maxtempC']}℃\n最低温：{forecast['mintempC']}℃\n"
            f"天气：{forecast['hourly'][0]['weatherDesc'][0]['value']}\n"
            f"湿度：{forecast['hourly'][0]['humidity']}%"
        )

    def fallback(self, error: Exception, **kwargs) -> str:
        return f"天气数据暂时不可用，请稍后重试。"
