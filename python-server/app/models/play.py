"""
趣味互动模块的数据模型（Pydantic）

对齐前端 `client/src/hooks/usePlay.ts` 与 `api.ts` 的契约（原 Express 后端
Zod schema 迁移而来）。字段用驼峰，理由同 growth.py ——「契约一致性优先」，
前端零改动接入。

校验边界（对照原 Zod schema）：
  - childAge：0-12 岁（整数）
  - storyType：bedtime / adventure / educational
  - difficulty：easy / medium / hard
  - description：2-500 字
  - babyAge：0-36 个月
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class StoryRequest(BaseModel):
    """生成故事请求体"""
    childAge: int = Field(..., ge=0, le=12)
    interest: Optional[str] = Field(None, max_length=100)
    storyType: Optional[Literal["bedtime", "adventure", "educational"]] = None


class RiddleRequest(BaseModel):
    """生成谜语请求体"""
    childAge: int = Field(..., ge=0, le=12)
    difficulty: Optional[Literal["easy", "medium", "hard"]] = None


class RiddleGuessRequest(BaseModel):
    """猜谜 / 求提示请求体（guess 与 hint 二选一）"""
    riddleId: str = Field(..., min_length=1)
    guess: Optional[str] = None
    hint: Optional[bool] = None


class BabyTalkRequest(BaseModel):
    """婴语解读请求体"""
    description: str = Field(..., min_length=2, max_length=500)
    babyAge: Optional[int] = Field(None, ge=0, le=36)
