from openai import OpenAI

from app.core.config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL

# 初始化 DeepSeek 客户端
deepseek_client = OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url=DEEPSEEK_BASE_URL,
)

def call_deepseek(prompt: str) -> str:
    """调用 DeepSeek 生成回答"""
    response = deepseek_client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=1.5,
        top_p=0.9,
        max_tokens=1000,
        stream=False  # 这里不使用流式响应,
    )
    # 如果不是流式响应，直接返回完整回答

    return response.choices[0].message.content


# 流式输出生成器
def generate_stream(prompt: str):
    """调用 DeepSeek 生成流式回答（纯 LLM 调用，不含检索逻辑）"""
    stream = deepseek_client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=1000,
        stream=True,
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta