"""轻量三态熔断器（对应笔记「高并发基础与限流熔断降级」§3.2）

不引第三方库，手写 Closed / Open / Half-Open 状态机。
配合 llm.py 里的调用：allow_request() 判断要不要放行，
record_success() / record_failure() 上报调用结果。

前端类比：这就是一个「按钮禁用 + 定时重试」的逻辑——
连续点 N 次失败就禁用按钮 open_timeout 秒，到期放 1 次试探，
成功就恢复，失败继续禁用。
"""

import time
import threading
from enum import Enum


class CircuitState(Enum):
    CLOSED = "closed"        # 正常放行
    OPEN = "open"            # 熔断中，拒绝请求
    HALF_OPEN = "half_open"  # 半开，放行少量试探请求


class CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = 5,     # 连续失败 N 次触发熔断
        open_timeout: int = 30,         # 熔断时长（秒），到期后半开试探
        half_open_limit: int = 1,       # 半开状态放行的试探请求数
    ):
        self.failure_threshold = failure_threshold
        self.open_timeout = open_timeout
        self.half_open_limit = half_open_limit
        self._state = CircuitState.CLOSED
        self._failures = 0
        self._opened_at = 0.0
        self._half_open_count = 0
        self._lock = threading.Lock()   # 高并发下状态变更要加锁

    @property
    def state(self) -> CircuitState:
        return self._state

    def allow_request(self) -> bool:
        """调用前问一句：这个请求能不能放行？"""
        with self._lock:
            if self._state == CircuitState.CLOSED:
                return True
            if self._state == CircuitState.OPEN:
                # 熔断期到了 → 转半开，落到下面按 HALF_OPEN 计数放行
                if time.time() - self._opened_at >= self.open_timeout:
                    self._state = CircuitState.HALF_OPEN
                    self._half_open_count = 0
                else:
                    return False  # 还在熔断期，拒绝
            # HALF_OPEN（含刚从 OPEN 转来的）：只放行 limit 个试探，其余拒绝（走降级兜底）
            if self._half_open_count < self.half_open_limit:
                self._half_open_count += 1
                return True
            return False

    def record_success(self):
        """调用成功 → 复位回 Closed"""
        with self._lock:
            self._state = CircuitState.CLOSED
            self._failures = 0
            self._half_open_count = 0

    def record_failure(self):
        """调用失败 → 累计，达到阈值就熔断"""
        with self._lock:
            self._failures += 1
            if self._state == CircuitState.HALF_OPEN:
                self._open()  # 半开试探失败，立刻重新熔断
            elif self._failures >= self.failure_threshold:
                self._open()

    def _open(self):
        self._state = CircuitState.OPEN
        self._opened_at = time.time()
        self._half_open_count = 0
