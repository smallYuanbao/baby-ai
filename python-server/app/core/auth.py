"""
轻量 API Key 鉴权 + 多租户隔离（方案 A）

## 为什么用 API Key 而非 JWT？

| | API Key | JWT |
|---|---|---|
| 本质 | 「key → user_id」的映射表 | 无状态签名令牌 |
| 服务端状态 | 需要存映射（dict / DB / Redis） | 无状态，靠签名校验 |
| 适用场景 | 服务间调用、demo、内部系统 | 多实例、需签发的用户体系 |
| 演进成本 | 低，先跑通隔离 | 高，要管签发/刷新/过期 |

方案 A 先用进程内 dict 存映射（单实例 demo 够用），面试讲方案 B 时再升到
Redis / 数据库 / JWT。

## 三个概念的边界（面试必问）

- **认证（Authentication）**：你是谁 —— API Key / JWT / 密码
- **授权（Authorization）**：你能干什么 —— RBAC（角色-权限）
- **多租户隔离（Tenancy）**：你只能看到自己的数据 —— 每个数据行加 owner 字段 + 查询过滤

本文件只做「认证 + 把 user_id 解析出来」，隔离靠各存储层加 `user_id` 过滤。

## 面试点：为什么 API Key 放 Header 而不是 query？

放 query（`?api_key=xxx`）会被记进访问日志、浏览器历史、CDN 日志，等于明文泄露。
放 `Authorization: Bearer <key>` 是约定俗成的安全位置，走 HTTPS 不落日志。
"""

from fastapi import Header, HTTPException

# key → user_id 映射（进程内，demo 规模；生产应放环境变量 / Redis / DB）
# 预置两个用户，用于演示多租户隔离：alice 建的宝宝档案、传的文件，bob 都看不到。
API_KEYS: dict[str, str] = {
    "dev-key-alice": "user_alice",
    "dev-key-bob": "user_bob",
}

# 未带 key 时兜底的匿名用户（宽松模式）。
# 生产应开严格模式：所有受保护接口一律 401，拒绝匿名访问。
ANONYMOUS_USER = "user_anonymous"


def get_current_user_id(authorization: str | None = Header(default=None)) -> str:
    """
    FastAPI dependency：从 `Authorization: Bearer <key>` 解析出 user_id。

    - 未带 Authorization 头 → 返回匿名用户（宽松模式，便于本地 demo 不破坏既有调用）
    - 带了但格式不对 / key 无效 → 401（明确拒绝非法凭证）

    下游各端点拿到 user_id 后，必须把它传进存储层做查询过滤（见 growth_store / upload /
    retriever），这才是隔离真正生效的地方。
    """
    if authorization is None or authorization.strip() == "":
        return ANONYMOUS_USER

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="无效的 Authorization 头格式")

    user_id = API_KEYS.get(token.strip())
    if user_id is None:
        raise HTTPException(status_code=401, detail="无效的 API Key")

    return user_id
