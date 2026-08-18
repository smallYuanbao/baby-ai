"""
趣味互动路由（Play Routes）

从原 Express 后端 `server/src/routes/play.ts` 迁移而来，接口契约保持不变：
  - POST /api/play/story        —— SSE 流式生成儿童故事
  - POST /api/play/riddle       —— AI 生成谜语（答案存服务端，不返回给前端）
  - POST /api/play/riddle/guess —— 校验谜底 / 请求提示
  - POST /api/play/baby-talk    —— "婴语翻译"趣味解读

设计要点（面试常问）：
  1. 谜语答案用进程内 TTL 缓存（TTLCache，5 分钟过期）存服务端，前端只能拿到
     riddleId，无法"作弊"看到答案；猜对立即 delete 防重放。
  2. 谜语生成要求 LLM 输出严格 JSON，解析失败时降级到兜底谜语，保证游戏不崩。
  3. 答案匹配用模糊逻辑（完全相等 / 子串包含），宽容儿童的近似输入。
"""

import json
import random
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.cache import TTLCache
from app.models.chat import ChatMessage, ChatOptions
from app.models.play import (
    BabyTalkRequest,
    RiddleGuessRequest,
    RiddleRequest,
    StoryRequest,
)
from app.services.llm import call_deepseek, generate_stream_with_interrupt_and_fallback
from app.services.play_prompts import BABY_TALK_PROMPT, RIDDLE_PROMPT, STORY_PROMPT
from app.utils.logger import logger

router = APIRouter(prefix="/api/play", tags=["play"])

# 谜语答案存储：进程内 TTL 缓存，5 分钟过期（对齐原 TS 后端的 Map + setInterval 清理）
# value 结构：{"answer": str, "hints": list[str]}
riddle_store = TTLCache(maxsize=512, ttl=300)

_STORY_TYPE_MAP = {"bedtime": "睡前故事", "adventure": "冒险故事", "educational": "教育故事"}


# ===============================================================
# 儿童故事生成（SSE）
# ===============================================================

@router.post("/story")
async def story(data: StoryRequest, request: Request):
    """流式生成儿童故事，token 包装成 SSE 事件（对齐 chat 流式格式）"""
    user_message = f"请为{data.childAge}岁的小朋友创作一个故事。"
    if data.storyType:
        user_message += f"故事类型：{_STORY_TYPE_MAP[data.storyType]}。"
    if data.interest:
        user_message += f"小朋友喜欢：{data.interest}。"

    messages = [
        ChatMessage(role="system", content=STORY_PROMPT),
        ChatMessage(role="user", content=user_message),
    ]

    async def gen():
        async for chunk in generate_stream_with_interrupt_and_fallback(messages, request):
            yield f"event: token\ndata: {json.dumps({'text': chunk}, ensure_ascii=False)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ===============================================================
# 谜语生成（非流式，答案存服务端）
# ===============================================================

@router.post("/riddle")
def riddle(data: RiddleRequest):
    """生成谜语；答案 + 提示存服务端，仅返回公开字段"""
    user_message = f"请为{data.childAge}岁的小朋友设计一个谜语。"
    if data.difficulty:
        user_message += f"难度：{data.difficulty}。"

    content = call_deepseek(
        [
            ChatMessage(role="system", content=RIDDLE_PROMPT),
            ChatMessage(role="user", content=user_message),
        ],
        ChatOptions(temperature=0.8),
    )

    # 解析 LLM 返回的 JSON：先正则提取（兼容 ```json 代码块包裹），再直接 parse，
    # 都失败则降级到兜底谜语，保证游戏不中断。
    try:
        match = re.search(r"\{[\s\S]*\}", content)
        riddle_data = json.loads(match.group(0)) if match else json.loads(content)
    except (json.JSONDecodeError, AttributeError):
        logger.warning("[play] 谜语 JSON 解析失败，走兜底谜语")
        riddle_data = {
            "riddle": content.strip() or "我圆圆的、红红的，长在树上，咬一口甜甜的，是什么呀？",
            "category": "生活",
            "difficulty": "easy",
            "answer": "苹果",
            "hints": ["它是一种水果哦~", "它的颜色很喜庆", "圣诞节常用来装饰"],
        }

    riddle_id = f"rid_{random.randbytes(4).hex()}"
    riddle_store.set(
        riddle_id,
        {"answer": (riddle_data.get("answer") or "").strip(), "hints": riddle_data.get("hints") or []},
    )

    return {
        "riddleId": riddle_id,
        "riddle": riddle_data.get("riddle", ""),
        "category": riddle_data.get("category", "生活"),
        "difficulty": riddle_data.get("difficulty", "easy"),
    }


# ===============================================================
# 猜谜 / 求提示
# ===============================================================

@router.post("/riddle/guess")
def guess(data: RiddleGuessRequest):
    """提交猜测或请求下一个提示"""
    stored = riddle_store.get(data.riddleId)
    if stored is None:
        return JSONResponse(
            status_code=404,
            content={"error": "谜语已过期，请重新出题", "code": "RIDDLE_EXPIRED"},
        )

    # 提示模式：每次给第一个还没给的提示（shift，消费即删）
    if data.hint:
        hint_text = stored["hints"][0] if stored["hints"] else "没有更多提示啦~"
        if stored["hints"]:
            stored["hints"].pop(0)
        return {"hint": hint_text, "correct": False}

    # 猜谜模式：空输入校验
    if not data.guess or not data.guess.strip():
        return JSONResponse(
            status_code=400,
            content={"error": "请输入你的答案", "code": "NO_GUESS"},
        )

    answer = stored["answer"]
    guess_text = data.guess.strip()
    # 模糊匹配：完全相等 / 互相子串包含（宽容儿童近似输入）
    is_correct = guess_text == answer or guess_text in answer or answer in guess_text

    if is_correct:
        riddle_store.delete(data.riddleId)  # 答对即删，防重放
        encouragement = random.choice([
            "太棒了！你真聪明！🌟",
            "答对啦！你好厉害！🎉",
            "完全正确！看来你是个猜谜高手！🏆",
        ])
        return {"correct": True, "answer": answer, "encouragement": encouragement}

    return {"correct": False, "encouragement": "不对哦，再想想！💪"}


# ===============================================================
# 婴语翻译（非流式）
# ===============================================================

@router.post("/baby-talk")
def baby_talk(data: BabyTalkRequest):
    """趣味解读宝宝行为，返回"宝宝内心 OS"翻译"""
    user_message = f"宝宝表现描述：{data.description}"
    if data.babyAge is not None:
        user_message += f"\n宝宝年龄：{data.babyAge}个月"

    content = call_deepseek(
        [
            ChatMessage(role="system", content=BABY_TALK_PROMPT),
            ChatMessage(role="user", content=user_message),
        ],
        ChatOptions(temperature=0.9, maxTokens=500),
    )
    return {"interpretation": content}
