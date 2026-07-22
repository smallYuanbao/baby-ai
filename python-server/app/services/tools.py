

# 工具定义：告诉 LLM 这个工具的用途和参数
import requests

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "strict": True,
        "description": "获取指定城市指定日期的天气，每次只返回单日数据。支持今天、明天、后天或具体日期(如2026-07-22)，如需查询多天请分别调用",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "城市名称，例如：北京、上海",
                },
                "date": {
                    "type": "string", 
                    "description": "日期，如 2026-07-21、今天、明天"
                }
            },
            "required": ["city"],
            "additionalProperties": False
        }
    }
}

def get_weather(city: str, date: str = "今天") -> dict:
    """调用 wttr.in 免费天气 API，支持指定日期（今天/明天/后天...）"""
    url = f"https://wttr.in/{city}?format=j1"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    # 找到对应日期的天气预报
    date_map = {"今天": 0, "明天": 1, "后天": 2}
    if date in date_map:
        forecast = data["weather"][date_map[date]]
    else:
        # 具体日期如 "2026-07-25" → 在 weather 数组里逐条匹配
        forecast = None
        for day in data["weather"]:
            if day["date"] == date:
                forecast = day
                break
        if forecast is None:
            # 日期超出预报范围（wttr.in 一般返回3-5天），退化到查今天
            forecast = data["weather"][0]

    return {
        "city": city,
        "date": forecast["date"],
        "max_temp": forecast["maxtempC"],
        "min_temp": forecast["mintempC"],
        "avg_temp": forecast["avgtempC"],
        "weather_desc": forecast["hourly"][0]["weatherDesc"][0]["value"],
        "humidity": forecast["hourly"][0]["humidity"],
    }
