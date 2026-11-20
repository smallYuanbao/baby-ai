"""熔断器三态状态机单测（对应「高并发基础」§3 熔断）

用 FakeClock + monkeypatch 控制时间，不依赖真实 sleep，
覆盖 Closed / Open / Half-Open 的完整状态迁移路径。
"""

import pytest

from app.core.circuit_breaker import CircuitBreaker, CircuitState


class FakeClock:
    """可控时钟：手动 advance 推进时间，替代真实 time.time()"""

    def __init__(self):
        self.now = 0.0

    def time(self) -> float:
        return self.now

    def advance(self, seconds: float):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    """把 circuit_breaker 内部用到的 time.time 替换成可控时钟"""
    c = FakeClock()
    monkeypatch.setattr("app.core.circuit_breaker.time.time", c.time)
    return c


# ---------------------------------------------------------------
# Closed 状态
# ---------------------------------------------------------------

def test_initial_state_is_closed():
    """初始状态必须是 CLOSED（正常放行）"""
    breaker = CircuitBreaker()
    assert breaker.state == CircuitState.CLOSED


def test_closed_allows_all_requests():
    """Closed 状态无条件放行，不限次数"""
    breaker = CircuitBreaker(failure_threshold=3)
    for _ in range(10):
        assert breaker.allow_request() is True


# ---------------------------------------------------------------
# Closed -> Open
# ---------------------------------------------------------------

def test_open_after_failure_threshold():
    """连续失败达到阈值才熔断，阈值之前保持 CLOSED"""
    breaker = CircuitBreaker(failure_threshold=3)

    breaker.record_failure()
    breaker.record_failure()
    assert breaker.state == CircuitState.CLOSED  # 2 次还没到阈值

    breaker.record_failure()
    assert breaker.state == CircuitState.OPEN  # 第 3 次触发熔断


def test_success_resets_failure_count():
    """成功调用会清零失败计数，避免「累积」式熔断"""
    breaker = CircuitBreaker(failure_threshold=3)

    breaker.record_failure()
    breaker.record_failure()
    breaker.record_success()  # 复位
    breaker.record_failure()
    breaker.record_failure()
    assert breaker.state == CircuitState.CLOSED  # 复位后重新计数，2 次不到阈值


# ---------------------------------------------------------------
# Open 状态
# ---------------------------------------------------------------

def test_open_rejects_requests_during_timeout(clock):
    """熔断期内拒绝所有请求"""
    breaker = CircuitBreaker(failure_threshold=1, open_timeout=30)
    breaker.record_failure()  # 触发熔断
    assert breaker.state == CircuitState.OPEN

    clock.advance(29)  # 还没到 30 秒
    assert breaker.allow_request() is False


def test_open_transitions_to_half_open_after_timeout(clock):
    """熔断期到期 → 转半开，放行试探请求"""
    breaker = CircuitBreaker(failure_threshold=1, open_timeout=30)
    breaker.record_failure()
    assert breaker.state == CircuitState.OPEN

    clock.advance(30)  # 刚好到期
    assert breaker.allow_request() is True
    assert breaker.state == CircuitState.HALF_OPEN


# ---------------------------------------------------------------
# Half-Open 状态
# ---------------------------------------------------------------

def test_half_open_success_resets_to_closed(clock):
    """半开试探成功 → 复位回 CLOSED"""
    breaker = CircuitBreaker(failure_threshold=1, open_timeout=30, half_open_limit=1)
    breaker.record_failure()  # OPEN
    clock.advance(30)
    breaker.allow_request()   # 半开放行 1 个试探

    breaker.record_success()  # 试探成功
    assert breaker.state == CircuitState.CLOSED


def test_half_open_failure_reopens(clock):
    """半开试探失败 → 立刻重新熔断"""
    breaker = CircuitBreaker(failure_threshold=1, open_timeout=30, half_open_limit=1)
    breaker.record_failure()  # OPEN
    clock.advance(30)
    breaker.allow_request()   # 半开放行试探

    breaker.record_failure()  # 试探失败
    assert breaker.state == CircuitState.OPEN


def test_half_open_only_allows_limit_probes(clock):
    """半开只放行 half_open_limit 个试探，多余请求走降级

    这是实现时踩过的坑：转半开时若直接 return True 而不计数，
    会多放一个请求。这里验证 half_open_limit=1 时严格只放行 1 个。
    """
    breaker = CircuitBreaker(failure_threshold=1, open_timeout=30, half_open_limit=1)
    breaker.record_failure()  # OPEN

    clock.advance(31)
    assert breaker.allow_request() is True   # 第 1 个试探放行
    assert breaker.allow_request() is False  # 第 2 个必须拒绝（走降级兜底）


def test_half_open_limit_two_probes(clock):
    """half_open_limit=2 时半开放行 2 个试探，第 3 个拒绝"""
    breaker = CircuitBreaker(failure_threshold=1, open_timeout=30, half_open_limit=2)
    breaker.record_failure()  # OPEN

    clock.advance(31)
    assert breaker.allow_request() is True
    assert breaker.allow_request() is True
    assert breaker.allow_request() is False
