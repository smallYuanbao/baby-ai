import json

from app.services.rag import chroma_client
from app.services.llm import deepseek_client
from app.utils.logger import logger

PROFILE_COLLECTION = "user_profiles"


def _ensure_collection():
    """确保 user_profiles 集合存在"""
    try:
        return chroma_client.get_or_create_collection(PROFILE_COLLECTION)
    except Exception as e:
        logger.error("[用户档案] 获取集合失败: %s", e)
        return None

def extract_profile(user_message: str, assistant_answer: str) -> dict:
    """
    从对话中提取用户关键信息（月龄、过敏史、关注主题等）
    返回结构化档案
    """

    prompt = f"""从以下育儿对话中提取宝宝的关键信息。只提取明确提到的信息，不要推测。

对话：
用户：{user_message}
助手：{assistant_answer[:500]}

请以 JSON 格式返回，只包含以下字段（没有提到的就不返回）：
- baby_age: 宝宝月龄或年龄（如"3个月"、"1岁"）
- allergies: 过敏史列表（如["牛奶蛋白", "鸡蛋"]）
- concerns: 关注主题列表（如["睡眠", "喂养", "湿疹"]）
- other: 其他重要信息（如早产、特殊疾病等）

如果没有任何可提取的信息，返回空对象 {{}}。

JSON："""

    resp = deepseek_client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=200
    )
    logger.debug("[用户档案] LLM 原始响应: finish=%s tokens=%s", resp.choices[0].finish_reason, resp.usage.completion_tokens if resp.usage else '?')
    try:
        raw = resp.choices[0].message.content
        if not raw or not raw.strip():
            logger.warning("[用户档案] LLM 返回空内容，跳过提取")
            return {}
        profile = json.loads(raw)
        if profile:
            logger.info("[用户档案] 提取成功: %s", profile)
        else:
            logger.warning("[用户档案] 无有效信息可提取")
        return profile
    except json.JSONDecodeError as e:
        logger.error("[用户档案] 提取失败(JSON解析): %s, raw=%s", e, raw[:100])
        return {}

def save_profile(session_id: str, profile: dict):
    """将用户档案存入 ChromaDB（以 session_id 为文档 ID，方便更新）"""

    if not profile:
        return 

    # 将档案转为文本存入（方便检索）
    profile_text = json.dumps(profile, ensure_ascii=False)

    # 用 session_id 作为文档 ID，支持 upsert（更新或插入）
    try:
        col = _ensure_collection()
        if col is None:
            logger.error("[用户档案] 保存失败: 无法获取集合")
            return
        col.upsert(
            documents=[profile_text],
            ids=[f"profile_{session_id}"],
            metadatas=[{"session_id": session_id}]
        )
        logger.info("[用户档案] 保存成功: session=%s profile=%s", session_id, profile)
    except Exception as e:
        logger.error("[用户档案] 保存失败: %s", e)

def get_profile(session_id: str) -> dict | None:
    """根据 session_id 检索用户档案"""
    try:
        col = _ensure_collection()
        if col is None:
            return None
        result = col.get(ids=[f"profile_{session_id}"])
        if result and result['documents']:
            profile = json.loads(result['documents'][0])
            logger.info("[用户档案] 命中: session=%s profile=%s", session_id, profile)
            return profile
        logger.info("[用户档案] 未命中: session=%s", session_id)
    except Exception as e:
        logger.error("[用户档案] 检索失败: %s", e)

    return None

def profile_to_prompt(profile: dict) -> str:
    """将用户档案转为可注入 System Prompt 的文本"""

    if not profile:
        return ""

    parts = []
    if "baby_age" in profile:
        parts.append(f"宝宝年龄/月龄：{profile['baby_age']}")
    if "allergies" in profile:
        parts.append(f"过敏史：{', '.join(profile['allergies'])}")
    if "concerns" in profile:
        parts.append(f"重点关注：{', '.join(profile['concerns'])}")
    if "other" in profile:
        parts.append(f"其他信息：{profile['other']}")

    if parts:
        return "## 用户档案（长期记忆）\n" + "\n".join(parts) + "\n\n请根据以上用户信息提供个性化建议。"
    return ""
    
    