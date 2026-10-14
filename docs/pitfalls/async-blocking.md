# 踩坑:异步接口里的阻塞与取消

> `async def` 只是"可以 await",**不会自动让同步代码变成非阻塞的**。
> 这一章记两个坑:一个聊天请求把整个服务堵死 38 秒;以及"停止生成"按钮为什么停不掉最耗时的部分。

## 坑 1:`async def` 里跑同步代码,一个请求堵死整个服务

**现象**:聊天请求进行中,任何其他请求都排队干等。实测:

```
空闲时      /api/health → 1.3 毫秒
聊天进行中  /api/health → 38.2 秒      ← 整个服务被一个聊天请求按死
```

用户侧的表象是"点了快捷问题没反应"——因为新请求排在旧请求后面,连处理都没开始。

**根因**:`/api/chat/stream` 是 `async def` + 异步生成器,但里面两处全是同步调用:

1. `get_rag_context()` 整个是同步函数——BM25、ChromaDB、BGE 精排 HTTP,
   而且查询改写 / 意图复核 / 精排兜底**各自还会同步调一次 LLM**;
2. `generate_stream_with_interrupt_and_fallback()` 用的是**同步** `OpenAI` 客户端,
   却写成 `for chunk in stream` —— 每读一个 chunk 都是一次阻塞的网络调用。

这两处中间**没有任何 `await`**,事件循环全程拿不回控制权。

对比:`/api/chat`(非流式)是同步 `def`,FastAPI 会自动丢进线程池,所以那条路一直是好的。
**问题只出在"`async def` 里写了同步活"**。

**修法**:
- 检索丢线程池:`await run_in_threadpool(get_rag_context, ...)`
- 流式换异步客户端:`async_deepseek_client = AsyncOpenAI(...)` + `async for chunk in stream`,
  `finally` 里 `await stream.close()`

修完实测:

```
聊天进行中的 /api/health:  1.5 / 6.6 / 3.2 / 24.8 / 12.2 毫秒
```

**原理**:`async def` 里出现同步 IO,阻塞的不是"这个请求"而是**整个事件循环**——
同进程内所有请求、所有连接全部停摆。判断标准很简单:

> **这个函数里有 `await` 吗?没有的话,它就是一段同步代码,不管它被写在多 `async` 的函数里。**

`/api/upload` 有同样的问题(同步的 PDF 解析 + 向量化写在 `async def` 里),这次没改。

## 坑 2:"停止生成"停得掉 LLM,停不掉检索

**现象**:用户点了停止,后端还在跑几十秒。

实测时间线(客户端 4 秒时断开):

```
22:10:50  请求到达
22:10:54  客户端断开
22:11:36  后端才跑完 rerank          ← 客户端走了之后又干了 42 秒
22:11:38  「[流式] 客户端断开连接，终止生成」
```

**根因**:`request.is_disconnected()` 的检查**只写在 LLM 的 chunk 循环里**:

```python
async for chunk in generate_stream_with_interrupt_and_fallback(messages, request):
```

也就是**必须先走完整个检索**(几十秒),才有机会第一次检查客户端还在不在。
而检索恰恰是整条链路最慢的一段。

**修法**:两层。
- 检索丢进线程池后,同步代码没法 `await is_disconnected()`,所以起一个**轮询任务**去探连接,
  探到就置位一个 `threading.Event`;`get_rag_context` 新增 `should_abort` 参数,
  在**取历史 / 查询改写 / 意图路由 / 混合检索 / 精排**之后各插一个取消点,命中就抛 `RetrievalAborted`。
- LLM 开跑前再查一次:`if await request.is_disconnected(): return` —— 省掉一整个 LLM 调用。

修完实测:客户端断开 → **同一秒**探测器发现 → 检索跑到下一个取消点即放弃 → **不调 LLM、不写会话存储**。

> 最有价值的取消点是"混合检索之后"那一个:它能整段跳过后面 24 秒的精排。

**原理**:同步函数**无法被强制中断**——`anyio` 的 `to_thread` 被取消时只是"放弃等待",
线程还在跑。所以取消必须做成**协作式**的:异步侧置位,同步侧在检查点主动放弃。

**已知局限**:取消点是**阶段级**的。像那 24 秒的 BGE 调用是一个**不可分割的 HTTP 请求**,
打进去之后没法中途掐断。最坏情况是"点了停止,当前这个阶段还要跑完"。

## 坑 3:mock 打在了同步客户端上,测试真的打了线上 API

**现象**:改完流式(同步 `deepseek_client` → 异步 `async_deepseek_client`)后,原本通过的一个
回归测试开始报 `KeyError: 'max_tokens'`,而且日志里出现了真实的用量记录:

```
INFO | baby-ai | 消耗用量 | prompt_tokens=33, completion_tokens=2751
```

**根因**:测试是这么写的

```python
monkeypatch.setattr(llm.deepseek_client.chat.completions, "create", fake_create)
```

补丁打在**同步**客户端上,而代码已经改走**异步**客户端。补丁**静默失效**:
`monkeypatch` 不在意你 patch 的对象有没有被用到,测试于是变成了真实调用。

**修法**:patch 正确的对象,并且替身要满足新接口——异步流需要 `__aiter__`/`__anext__`
和**异步**的 `close()`:

```python
class FakeAsyncStream:
    def __aiter__(self): return self
    async def __anext__(self): raise StopAsyncIteration
    async def close(self): pass

async def fake_create(**kwargs): ...
monkeypatch.setattr(llm.async_deepseek_client.chat.completions, "create", fake_create)
```

**原理**:`monkeypatch.setattr` **不会告诉你打空了**——它只要求属性存在且可写。
所以"测试通过"可能是假的:

> **凡是 mock 外部依赖的测试,都该确认补丁真的生效了**(比如断言替身被调用过,
> 或者像这里一样断言捕获到的参数符合预期)。否则单测会悄悄退化成集成测试,
> 而且是**会花钱**的那种。
