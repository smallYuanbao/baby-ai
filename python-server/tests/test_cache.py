"""TTLCache 单元测试（对应「高并发基础」§4 缓存）

用 FakeClock 控制时间，覆盖 TTL 过期、LRU 淘汰、命中刷新等核心行为。
"""

import pytest

from app.core.cache import TTLCache


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
    """把 cache 内部用到的 time.time 替换成可控时钟"""
    c = FakeClock()
    monkeypatch.setattr("app.core.cache.time.time", c.time)
    return c


# ---------------------------------------------------------------
# 基本 get/set
# ---------------------------------------------------------------

def test_set_get_basic():
    cache = TTLCache()
    cache.set("k", "v")
    assert cache.get("k") == "v"


def test_get_missing_returns_none():
    cache = TTLCache()
    assert cache.get("nope") is None


# ---------------------------------------------------------------
# TTL 过期
# ---------------------------------------------------------------

def test_ttl_expiry(clock):
    cache = TTLCache(ttl=10)
    cache.set("k", "v")
    assert cache.get("k") == "v"

    clock.advance(9)
    assert cache.get("k") == "v"  # 还没到期

    clock.advance(1)  # 累计 10 秒，刚好到期
    assert cache.get("k") is None  # 惰性过期删除


def test_set_override_ttl(clock):
    """单条写入可覆盖默认 TTL"""
    cache = TTLCache(ttl=100)
    cache.set("k", "v", ttl=5)
    clock.advance(5)
    assert cache.get("k") is None


# ---------------------------------------------------------------
# LRU 淘汰
# ---------------------------------------------------------------

def test_lru_eviction():
    """写入超过 maxsize 时淘汰最久未用的"""
    cache = TTLCache(maxsize=3)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    cache.set("d", 4)  # 超容，淘汰最久未用的 a
    assert cache.get("a") is None
    assert cache.get("b") == 2
    assert cache.get("c") == 3
    assert cache.get("d") == 4


def test_lru_hit_refreshes_order():
    """命中会把条目标记为「最近使用」，改变淘汰顺序"""
    cache = TTLCache(maxsize=3)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    cache.get("a")  # a 变成最近使用
    cache.set("d", 4)  # 超容，淘汰最久未用的 b（而非 a）
    assert cache.get("b") is None
    assert cache.get("a") == 1
    assert cache.get("c") == 3
    assert cache.get("d") == 4


# ---------------------------------------------------------------
# 清理
# ---------------------------------------------------------------

def test_clear_and_len():
    cache = TTLCache()
    cache.set("x", 1)
    cache.set("y", 2)
    assert len(cache) == 2

    cache.clear()
    assert len(cache) == 0
    assert cache.get("x") is None
