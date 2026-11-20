"""趣味互动模块（play）逻辑单元测试

聚焦无需真实 LLM 调用的部分：
  - 谜语 guess/hint 逻辑：模糊匹配、提示逐个消费、过期 404、空输入 400
  - 请求模型校验边界

不测 story/riddle 生成（依赖 DeepSeek API），那些留给联调验证。
"""

import pytest
from fastapi.responses import JSONResponse

from app.api.play import guess, riddle_store
from app.models.play import (
    BabyTalkRequest,
    RiddleGuessRequest,
    RiddleRequest,
    StoryRequest,
)


@pytest.fixture
def clean_store():
    """每个测试前后清空谜语存储，避免用例间串扰"""
    riddle_store.clear()
    yield riddle_store
    riddle_store.clear()


def _seed_riddle(riddle_id="rid_test", answer="苹果", hints=None):
    riddle_store.set(riddle_id, {"answer": answer, "hints": hints or ["提示1", "提示2", "提示3"]})


# ---------------------------------------------------------------
# 猜谜：模糊匹配 + 答对即删
# ---------------------------------------------------------------

def test_guess_exact_match(clean_store):
    _seed_riddle(answer="苹果")
    result = guess(RiddleGuessRequest(riddleId="rid_test", guess="苹果"))
    assert result["correct"] is True
    assert result["answer"] == "苹果"
    assert result["encouragement"]
    # 答对即删，防重放
    assert riddle_store.get("rid_test") is None


def test_guess_substring_match_is_lenient(clean_store):
    """儿童输入近似答案（如含答案子串）也应判对"""
    _seed_riddle(answer="大熊猫")
    result = guess(RiddleGuessRequest(riddleId="rid_test", guess="熊猫"))
    assert result["correct"] is True


def test_guess_wrong(clean_store):
    _seed_riddle(answer="苹果")
    result = guess(RiddleGuessRequest(riddleId="rid_test", guess="香蕉"))
    assert result["correct"] is False
    assert result["encouragement"]
    # 猜错不删除，可继续猜
    assert riddle_store.get("rid_test") is not None


def test_guess_expired_returns_404(clean_store):
    resp = guess(RiddleGuessRequest(riddleId="rid_ghost", guess="苹果"))
    assert isinstance(resp, JSONResponse)
    assert resp.status_code == 404
    assert resp.body  # {error, code: RIDDLE_EXPIRED}


def test_guess_empty_returns_400(clean_store):
    _seed_riddle()
    resp = guess(RiddleGuessRequest(riddleId="rid_test", guess="   "))
    assert isinstance(resp, JSONResponse)
    assert resp.status_code == 400


# ---------------------------------------------------------------
# 提示：逐个消费（shift），耗尽给兜底
# ---------------------------------------------------------------

def test_hint_consumes_in_order(clean_store):
    _seed_riddle(hints=["提示1", "提示2", "提示3"])
    first = guess(RiddleGuessRequest(riddleId="rid_test", hint=True))
    second = guess(RiddleGuessRequest(riddleId="rid_test", hint=True))
    assert first["hint"] == "提示1"
    assert second["hint"] == "提示2"
    assert first["correct"] is False


def test_hint_exhausted_fallback(clean_store):
    _seed_riddle(hints=["唯一提示"])
    guess(RiddleGuessRequest(riddleId="rid_test", hint=True))  # 消耗掉
    result = guess(RiddleGuessRequest(riddleId="rid_test", hint=True))
    assert result["hint"] == "没有更多提示啦~"


# ---------------------------------------------------------------
# 请求模型校验边界
# ---------------------------------------------------------------

def test_story_request_bounds():
    assert StoryRequest(childAge=4).childAge == 4
    with pytest.raises(Exception):
        StoryRequest(childAge=99)  # 超上限


def test_riddle_request_difficulty_enum():
    assert RiddleRequest(childAge=5, difficulty="easy").difficulty == "easy"
    with pytest.raises(Exception):
        RiddleRequest(childAge=5, difficulty="impossible")


def test_baby_talk_description_length():
    with pytest.raises(Exception):
        BabyTalkRequest(description="短")  # 不足 2 字
    with pytest.raises(Exception):
        BabyTalkRequest(description="长" * 501, babyAge=30)  # 超 500 字
    with pytest.raises(Exception):
        BabyTalkRequest(description="正常描述", babyAge=99)  # 月龄越界
