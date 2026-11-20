"""进程内 TTL 缓存（对应笔记「高并发基础与限流熔断降级」§4 缓存）

学习项目没有 Redis，先用进程内 dict 实现一个轻量缓存，
对外提供与 Redis 一致的 get/set 接口 —— 后续要上 Redis，
只需把 get/set 的实现换成 redis-py，调用方零改动。

三个关键设计点（面试常问）：
1. TTL 过期：每条记录带 expire_at，get 时惰性判断，过期即删。
2. LRU 淘汰：用 OrderedDict，命中/写入都 move_to_end，超 maxsize 时
   popitem(last=False) 淘汰最久未用的那条。
3. 线程安全：get/set/clear 全部加锁，避免高并发下 dict 并发读写出错。

前端类比：类似浏览器里的 LRU 缓存 / localStorage，只不过放在服务端。
注意：进程内缓存是「单进程不共享」的 —— 多实例部署时 A 实例写入，
B 实例读不到，所以生产多副本要换 Redis（这是面试区分点）。
"""

import time
import threading
from collections import OrderedDict


class TTLCache:
    def __init__(self, maxsize: int = 512, ttl: int = 300):
        """
        :param maxsize: 最多缓存多少条，超过按 LRU 淘汰最久未用的
        :param ttl:     默认过期秒数（set 时可单独覆盖）
        """
        self.maxsize = maxsize
        self.ttl = ttl
        self._data: "OrderedDict[str, tuple[float, object]]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str):
        """命中返回 value；未命中或已过期返回 None"""
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None

            expire_at, value = item
            if time.time() >= expire_at:
                del self._data[key]  # 惰性删除过期项
                return None

            self._data.move_to_end(key)  # LRU：命中即视为「最近使用」
            return value

    def set(self, key: str, value, ttl: int = None):
        """写入一条；ttl 为 None 时用默认过期时间"""
        expire_at = time.time() + (ttl if ttl is not None else self.ttl)
        with self._lock:
            self._data[key] = (expire_at, value)
            self._data.move_to_end(key)
            # 超出容量就淘汰最久未用的（OrderedDict 头部）
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def delete(self, key: str) -> bool:
        """删除一条；存在并删除返回 True，不存在返回 False"""
        with self._lock:
            if key in self._data:
                del self._data[key]
                return True
            return False

    def clear(self):
        with self._lock:
            self._data.clear()

    def __len__(self):
        with self._lock:
            return len(self._data)
