"""会话历史路由（Session Routes）

给客户端做「刷新不丢对话 / 历史会话列表」用的只读接口。
写入不在这里：消息由聊天管道在每轮结束时落库（见 services/pipeline/session.py），
这样"哪一轮该存什么"只在一个地方决定，不会出现两条写入路径各存一半。
"""

from fastapi import APIRouter, Depends

from app.core.auth import get_current_user_id
from app.services.pipeline import session as session_store

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.get("")
def list_sessions(user_id: str = Depends(get_current_user_id)):
    """当前用户的历史会话（按最近活动倒序）。"""
    return session_store.list_sessions(user_id)


@router.get("/{session_id}")
def get_session(session_id: str, user_id: str = Depends(get_current_user_id)):
    """某个会话的完整消息。

    未知 session_id 返回空列表（不 404）：客户端 localstorage 里的 id 可能已经
    因为清库/换用户而失效，此时应当表现为"没有历史"，而不是一个红色报错。
    """
    return {
        "sessionId": session_id,
        "messages": session_store.get_session_messages(user_id, session_id),
    }


@router.delete("/{session_id}")
def delete_session(session_id: str, user_id: str = Depends(get_current_user_id)):
    """删除一个会话。

    幂等：不存在也返回成功。删除是用户的明确动作，重复点击/多端同时删
    不该弹"删除失败"。
    """
    session_store.delete_session(user_id, session_id)
    return {"success": True}
