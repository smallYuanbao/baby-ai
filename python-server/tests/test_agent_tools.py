"""Agent 工具调用的健壮性(Ch32 由评测平台扫出的缺口)。

这三件事都是 **LLM 的常见行为,不是边界情况**:
模型会报不存在的工具名、会给出截断的 JSON 参数、会把字段名写错。
原来的 `TOOL_MAP[tool_name]` / `json.loads(...)` 直接抛异常,
而这些异常被外层 `except Exception` 吞掉,表现为「回答失败」而非可诊断的错误。
"""
import pytest

from app.services.agent import base


def test_unknown_tool_does_not_raise():
    """模型幻觉一个工具名 → 返回 error 而不是 KeyError。"""
    r = base._run_tool("query_weather_on_mars", "{}")
    assert "error" in r
    assert "不存在" in r["error"]


def test_malformed_json_args_does_not_raise():
    """模型给出截断/多带文字的 arguments → 返回 error 而不是 JSONDecodeError。"""
    for bad in ("{not json", '{"city": "北京"', ""):
        r = base._run_tool("get_weather", bad)
        assert "error" in r


def test_wrong_arg_names_does_not_raise():
    """模型把字段名写错 → 返回 error 而不是 TypeError。"""
    r = base._run_tool("get_weather", '{"citty": "北京"}')
    assert "error" in r


def test_valid_call_still_works(monkeypatch):
    """正常调用不受影响——别为了防错把正确路径也拦了。"""
    monkeypatch.setitem(base.TOOL_MAP, "echo", lambda text: {"echo": text})
    assert base._run_tool("echo", '{"text": "hi"}') == {"echo": "hi"}
