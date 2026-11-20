# 踩坑:前后端数据契约

> 这一类坑的共同特征是:**两端各自都能跑通,只有拼在一起才出错**,而且错得不明显——
> 不报异常,只是渲染出空值或"看起来合理"的假值。

## 坑 1:引用(RAG 引用来源)的字段两端从来没对齐过

**现象**:引用卡片渲染出来是——徽章里一长串 `med_32ce4015`、标题空白、
相关性徽章显示「一般 **NaN%**」、摘要空白。

**根因**:两边的 `Reference` 结构从来不是一回事:

| | 字段 |
|---|---|
| 后端 `app/models/chat.py` | `{id, text}` |
| 前端 `types/chat.ts` 期望 | `{id, title, snippet, score}` |

而后端返回的 `text` 其实是**揉在一起的一段**:

```
【儿科其他】宝宝晚上哭啼怎么办
问：…
答：…
```

标题、正文、分类全糊在这一个字段里。前端拿 `title`/`snippet`/`score` 去取,自然全是 `undefined`;
`score` 为 `undefined` 时 `Math.round(undefined * 100)` → `NaN`。

前端还有一处连带:徽章渲染的是 `reference.id`,那是 ChromaDB 的分块 ID。
而徽章是 24px 的固定方块,本来就是给 1~2 位序号设计的。

**修法**:在**边界处**加一层归一化(`client/src/utils/reference.ts`),
把 `{id, text, score}` 转成界面要的 `{id, title, snippet, score}`:

- 从 `text` 里拆标题/正文(语料里见过三种排布,都要接住);
- `id` 只留作 React key,**徽章改显示序号**;
- `score` 缺失时**不显示**分数徽章,而不是显示一个假的 0。

后端同时把 `score` 补上(见坑 2)。

**原理**:放在前端边界做归一化,而不是去改后端模型——因为后端 `Reference` 被 **5 处**构造点
共用(`chat_service`、`agent/base`、`agent/unified`、`mcp_client`),改模型面太广;
而"怎么展示"本来就是这个界面自己的事。

> **两端的共享结构必须有唯一的定义处。** 这里的问题是前端 `Reference` 类型是"想要的样子",
> 后端 `Reference` 是"实际的样子",两者名字相同、字段不同,谁都没错,拼起来就错。

## 坑 2:精排一旦降级,所有引用分数都变成 1.0

**现象**:引用面板上 5 条来源全部显示「高相关 100%」。**比不显示分数还误导**——
用户会以为每条证据都一样可信。

**根因**:精排有三级降级(BGE → DeepSeek → 原始距离排序),兜底那级是这么写的:

```python
doc_copy["score"] = 1 - (d.distance or 0)
```

但 `hybrid_search()` 返回的文档**根本没有 `distance` 字段**(它填的是 `score`)。
于是 `d.distance or 0` 兜成 0,每篇文档都得到 `1 - 0 = 1.0`。

对照两种文档来源:

| 来源 | 有的字段 |
|---|---|
| `hybrid_search()` | `score`(混合检索算好的),**没有 `distance`** |
| ChromaDB 直查 | `distance`,没有 `score` |

兜底代码只认其中一种。

**修法**:抽一个 helper,优先用已有的 `score`,没有再退回距离换算:

```python
def _fallback_score(d: RAGDocument) -> float:
    if d.score is not None:
        return d.score
    return 1 - (d.distance or 0)
```

四处兜底打分全部改用它;顺带把"按 `distance or 0` 排序"改成按真实分数排序
(原来 distance 全为 None,`sorted` 实际是"保持原序",看着能跑纯属巧合)。

**原理**:`x or 默认值` 这个写法对 `None` 和 `0` 一视同仁——
**在"0 是合法值"的语义下就会出错**。这里的 `distance=0` 表示"完全匹配",极其相关,
但代码把它和"没有 distance"混为一谈了。

> 用 `or` 兜底之前先问:**这个字段取 0 是合法的吗?** 合法就不能用 `or`。

## 附:这一类的通用线索

三个坑都符合同一个模式——**失败时静默**:

| 坑 | 表面看到 | 实际发生 |
|---|---|---|
| 坑 1 | 空白标题、`NaN%` | 取不存在的字段,得到 `undefined` |
| 坑 2 | 「高相关 100%」 | 兜底路径把分数算成了常量 |

**这类坑不靠日志能发现,只能靠"显式渲染可疑值"**——比如 `NaN` 之所以被发现,
正是因为 `Math.round(undefined * 100)` 老老实实吐出了 `NaN`。
如果一个组件对缺失值默认渲染成空字符串,这个坑会一直藏着。
