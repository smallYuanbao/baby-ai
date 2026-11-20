from typing import Annotated
import json

import requests
from pydantic import Field

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("weather-service")


@mcp.tool()
def get_weather(
    city: Annotated[str, Field(description="城市名称，例如：北京、上海")],
    date: Annotated[str, Field(description="日期：今天/明天/后天")] = "今天",
) -> str:
    """获取指定城市指定日期的天气，每次只返回单日数据。支持今天、明天、后天"""
    # 中文日期 → 数组索引
    date_map = {"今天": 0, "明天": 1, "后天": 2}
    offset = date_map.get(date, 0)

    # 调 wttr.in 免费天气 API
    resp = requests.get(f"https://wttr.in/{city}?format=j1", timeout=10)
    resp.raise_for_status()
    forecast = resp.json()["weather"][offset]

    result = {
        "city": city,
        "date": forecast["date"],
        "max_temp": forecast["maxtempC"],
        "min_temp": forecast["mintempC"],
        "weather_desc": forecast["hourly"][0]["weatherDesc"][0]["value"],
    }
    return json.dumps(result, ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()
