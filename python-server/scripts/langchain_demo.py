import os

from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

# 指定 .env 的绝对路径
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL")
# 1. 定义 LLM（相当于你的 deepseek_client）
llm = ChatOpenAI(
    model="deepseek-v4-flash",
    openai_api_key=DEEPSEEK_API_KEY,
    openai_api_base=DEEPSEEK_BASE_URL,
    temperature=0.7
)

# 2. 定义 Prompt 模板（相当于你的 buildPrompt 函数）
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一个育儿专家助手。请根据以下参考资料回答用户问题。如果参考资料中没有相关信息，请根据你的知识礼貌回答。"),
    ("user", "参考资料：{context}\n\n用户问题：{question}\n\n回答：")
])

# 3. 定义输出解析器（把 LLM 返回的对象转成纯文本）
parser = StrOutputParser()


# | 管道符的含义：LangChain 用 | 把多个步骤串起来——上一个步骤的输出自动成为下一个步骤的输入。
# 相当于你手动写的 step1_output = step1(input); step2_output = step2(step1_output)，只是用管道符让代码更简洁。
# 4. 组装成 Chain（相当于你的 call_deepseek(prompt)）
chain = prompt | llm | parser

# 5. 运行
context = "宝宝发烧时，如果体温超过38.5度且精神状态不佳，可以考虑使用退烧药。"
question = "宝宝发烧38.5度，需要吃药吗？"

result = chain.invoke({
    "context": context,
    "question": question
})

print(result)
