# 踩坑:推理模型与输出预算

> baby-ai 的后端是 `deepseek-v4-flash` —— 一个**推理模型**,先输出 `reasoning_content`(思维链)
> 再输出 `content`(正文),**两者共用 `max_tokens`**。
> 这一章记的全是「给推理模型设预算」踩出来的坑:一个笔误把流式接口全打挂,三处沿用小值的
> 调用点静默失效,还有「预算到底该给多少」这个反直觉的结论。

## 坑 1:替换常量时顺手改错变量,流式接口全挂(而且验证覆盖不到)

**现象**:三个流式接口(`/api/chat/stream`、成长分析、讲故事)永远只回一句
「抱歉，当前服务繁忙，请稍后再试～」。但**引用照常返回**——所以从界面上看很像"模型抽风",
不像代码错。

**根因**:`llm.py` 里函数开头写了 `opts = options or ChatOptions()` 兜底(`options` 是可选参数),
但构造请求时用的是**原始参数** `options.maxTokens`。主聊天接口调用时**不传** `options`,
于是每次都在 `None.maxTokens` 上抛 `AttributeError`,被 `except` 吞掉后静默降级。

引入它的提交是 `bbb1f8a`(2026-10-14),本意只是把 `1000` 换成常量 `DEFAULT_MAX_TOKENS`,diff 长这样:

```diff
  # _call_deepseek_raw —— options 是必填参数,这处改对了 ✓
- max_tokens=options.maxTokens if options.maxTokens is not None else 1000,
+ max_tokens=options.maxTokens if options.maxTokens is not None else DEFAULT_MAX_TOKENS,

  # 下面两处 opts→options ✗
- max_tokens=opts.maxTokens if opts.maxTokens is not None else 1000,
+ max_tokens=options.maxTokens if options.maxTokens is not None else DEFAULT_MAX_TOKENS,
```

**修法**:把两处改回 `opts`。

**原理**:这次踩坑**真正值得记的不是笔误,而是它为什么没被测出来**。
该提交的验证结论写着「重启后零新增降级;52 测试全绿」——但评测走的是**非流式** `/api/chat`,
它落在 `_call_deepseek_raw` 那条**改对了**的路径上;而改错的两处都在**流式**路径上。

> **改一处配置值、三处一起动时,要问「我验证的是哪条路径」。**
> 同一个常量被多条调用链接着用,验证必须覆盖**每一条**,否则"全绿"只是覆盖不到的那条的沉默。

## 坑 2:三处沿用小预算的调用点,在换成推理模型后全部静默失效

**现象**:三处调用的实际表现各不相同,但都没有报错:

| 调用点 | 原 `maxTokens` | 实际症状 |
|---|---|---|
| `pipeline/intent.py` 意图分类 | 10 | `content` 恒为空 → 分类**每次都**降级成 `general`,系统提示词一直用错档 |
| `rag/reranker.py` LLM 精排 | 50 | 真实 prompt 下必空 → 整层精排静默退化成"按向量距离排序",等于没精排 |
| `api/play.py` 婴语翻译 | 500 | 恒定返回「抱歉，当前服务繁忙」——**这个功能一直是坏的** |

**根因**:模型是推理模型,预算不够时思维链先把额度烧完,`finish_reason=length`,
`content` 是空串,`call_deepseek` 于是走降级。

对照实验(同一 prompt 给不同预算):

```
max_tokens=10   → finish=length   content=''           思维链 52 字符
max_tokens=50   → finish=stop     content='illness'
max_tokens=500  → finish=length   content=''           (婴语翻译实测需要 1416)
max_tokens=4096 → finish=stop     content=正常
```

**这些值当时是对的。** git 溯源:`maxTokens` 这套机制来自重构前的 Express/TS 后端
(`server/src/services/deepseek.ts`,默认 `DEFAULT_MAX_TOKENS = 2048`),
`10` / `50` / `500` 都是从那边的调用点原样搬过来的。TS 侧还留着一句论证:

```
// maxTokens: 50 足够容纳 topK 个编号（每个编号 + 换行约 2-3 token）
```

时间线:

| 日期 | commit | 事件 |
|---|---|---|
| 2026-07-13 | `5dfc7f5` | Python 重构:丢掉 options 机制,硬编码 `max_tokens=1000`(比 TS 的 2048 还降一半) |
| 2026-07-15 | `4142d1b` | 意图路由:把 `maxTokens` 加回来,写下 `maxTokens=10` |
| 2026-07-20 | `8ae340a` | 精排:`maxTokens=50` |
| **2026-07-25** | **`a537f7a`** | **模型迁移 `deepseek-chat` → `deepseek-v4-flash`(换成推理模型)** |
| 2026-08-18 | `06e396b` | play 模块:`maxTokens=500` |

**转折点是 07-25 那次模型迁移**:在那之前 `max_tokens` 约等于"输出长度",10 个 token 回一个词
确实够;换成推理模型后它变成"思维链 + 正文"的共用额度,那些论证的前提被悄悄抽掉了,
而代码里一个注释都没改。

**修法**:
- `intent.py` → `SHORT_TASK_MAX_TOKENS`
- `reranker.py` → `DEFAULT_MAX_TOKENS`(精排量级和"选一个词"不是一回事,见坑 3)
- `play.py` → 去掉 `maxTokens`(这是**生成**任务,不是短任务)

**原理**:`max_tokens` 在非推理模型上是"输出上限",在推理模型上是"思维链 + 输出的总预算"。
**同一个数值在换模型时语义会变,而它不会报错。** 换模型时要专门过一遍所有显式设了预算的地方。

## 坑 3:预算给多少,要看"模型要读多少材料",不是"输出有多短"

**现象**:修完坑 2 后把意图分类设成 512,想的是"比实测峰值留点余量"。压测后发现**不够**。

**根因**:量了 7 类问题 × 5 次的 `completion_tokens` 分布,峰值来源和直觉相反:

| 问题 | question 长度 | tokens 峰值 |
|---|---|---|
| 短问题(8~12 字) | 8~12 字 | 100 |
| 超长问题 | **402 字** | 129 |
| **意图模糊的问题** | 35 字 | **441** |

**峰值不来自最长的问题,而来自模型"拿不准该归哪类"的问题**——「打完疫苗发烧 + 拉肚子 +
辅食要不要停」横跨 vaccine / illness / feeding 三个类别,它在取舍时想得最久。
同一问题反复跑还会飘(20 次里从 100 到 441)。

512 相对 441 只有 **1.2 倍余量**(那次离上限只差 71 个 token),于是改成 2048(4.6 倍)。

精排那条路另测:8 次采样 381~634 tokens、全部 `finish=stop`,4096 给 6.5 倍余量,足够。

**修法**:常量注释里写清实测分布 + 峰值来源,并把它固化成测试断言:

```python
MEASURED_TAIL_MAX = 441        # 意图分类实测尾部峰值
assert SHORT_TASK_MAX_TOKENS >= 4 * MEASURED_TAIL_MAX
```

**原理**:两条。
① **别用"输出很短"推预算**——要看模型要读多少材料、任务有多需要"想"。
   输出 5 个数字的精排,实测要 600+ token。
② **`max_tokens` 只是上限,按实际用量计费,给宽不会多花钱;定小了却会静默拿到空回答。**
   所以对"失败即静默"的场景,预算应该给得**过分充裕**。

## 坑 4:`call_deepseek` 失败时返回兜底话术,被下游当成正常结果用了

**现象**:查询改写拿到 `call_deepseek` 的返回值后直接 `.strip()` 当作"改写后的查询"。

**根因**:`call_deepseek` 失败时**不抛异常**,而是返回 `FALLBACK_TEXT`(「抱歉，当前服务繁忙…」)。
不当心的话它会被一路带下去:检索层拿着这句话去查,召回一堆无关文档;
而且 `wasRewritten=True` 还会让调用方**丢掉原始问题**。

**修法**:在改写里显式校验:

```python
if not rewritten or rewritten == FALLBACK_TEXT:
    raise ValueError("改写返回了空串或兜底文案")
```

让它走正常的 except 降级分支(退回原问题)。

**原理**:**「返回兜底值」和「抛异常」是两种失败信号,下游必须能分辨。**
这个项目里已经有先例——缓存那条路径专门有 `_is_cacheable()` 来拒绝 `FALLBACK_TEXT`。
凡是"返回值会被当作数据继续使用"的地方,都要检查它是不是兜底值。

## 附:一个我自己的误判(记下来免得下次又猜)

看到这些空响应时,我怀疑会累积**把熔断器打开**(阈值 5 次连续失败 → 全站降级 30 秒)。
实测**不会**:

```python
response = _call_deepseek_raw(messages, opts, stream=False)
breaker.record_success()          # ← HTTP 一成功就复位计数
content = response.choices[0].message.content
if not (content or "").strip():
    breaker.record_failure()      # ← 再 +1,于是永远停在 1
```

HTTP 请求本身是**成功**的,只是 `content` 空。所以每次都先 `record_success()` 复位。
**结论:没有级联风险,真实影响是静默的"质量降级"而非"可用性降级"。**

教训:**熔断器在"调用成功但结果不可用"这种情况下的行为,要看它记录成功的时机**——
写在 HTTP 返回之后、内容校验之前,就等于这类失败永远打不开熔断。
