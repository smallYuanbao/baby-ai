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


def get_current_user_id(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    authorization: str | None = Header(default=None),
) -> str:
    """
    FastAPI dependency：解析 user_id。

    优先读 `X-API-Key`，兼容旧的 `Authorization: Bearer <key>`。

    为什么优先用 X-API-Key：边缘代理（如 Caddy Basic Auth）也占用
    `Authorization` 头。前端如果继续发 `Bearer`，会把浏览器自动附带的
    `Basic` 凭据覆盖掉，导致 Basic Auth 反复弹框。拆成两个头后互不干扰。

    - 未带任何 key → 返回匿名用户（宽松模式，便于本地 demo）
    - 带了但 key 无效 → 401
    """
    token = (x_api_key or "").strip()
    if token:
        user_id = API_KEYS.get(token)
        if user_id is None:
            raise HTTPException(status_code=401, detail="无效的 API Key")
        return user_id

    # 兼容旧客户端 / curl 的 Bearer 方式
    if authorization is None or authorization.strip() == "":
        return ANONYMOUS_USER

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="无效的 Authorization 头格式")

    user_id = API_KEYS.get(token.strip())
    if user_id is None:
        raise HTTPException(status_code=401, detail="无效的 API Key")

    return user_id
