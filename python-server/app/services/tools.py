

# 工具定义：告诉 LLM 这个工具的用途和参数
import requests

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "strict": True,
        "description": "根据城市名称查询当前天气情况，包括温度、湿度、天气状况",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "城市名称，例如：北京、上海",
                }
            },
            "required": ["city"],
            "additionalProperties": False
        }
    }
}

def get_weather(city: str) -> dict:
    """调用免费天气 API 获取当前天气"""
    # 使用 wttr.in 免费天气 API，无需注册
    url = f"https://wttr.in/{city}?format=j1"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    current = data["current_condition"][0]
    return {
        "city": city,
        "temperature": current["temp_C"],
        "humidity": current["humidity"],
        "weather": current["weatherDesc"][0]["value"]
    }
