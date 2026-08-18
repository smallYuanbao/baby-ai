"""
成长记录路由（Growth Routes）

从原 Express 后端 `server/src/routes/growth.ts` 迁移而来，接口契约保持不变：
  - 宝宝档案 CRUD：/children
  - 成长记录 CRUD：/children/{childId}/records
  - 图表数据：/children/{childId}/chart-data?metric=weight
  - AI 健康分析（SSE）：POST /children/{childId}/analysis

错误响应统一返回 `{ error, code }`（对齐前端 ApiError 契约），而非 FastAPI
默认的 `{ detail }`。
"""

import json
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.models.chat import ChatMessage
from app.models.growth import (
    CreateChild,
    CreateGrowthRecord,
    UpdateChild,
    UpdateGrowthRecord,
)
from app.services import growth_store
from app.services.llm import generate_stream_with_interrupt_and_fallback
from app.utils.logger import logger

router = APIRouter(prefix="/api/growth", tags=["growth"])


def _not_found(message: str) -> JSONResponse:
    return JSONResponse(status_code=404, content={"error": message, "code": "NOT_FOUND"})


# ===============================================================
# 宝宝档案 CRUD
# ===============================================================

@router.get("/children")
def list_children():
    return growth_store.list_children()


@router.get("/children/{child_id}")
def get_child(child_id: str):
    child = growth_store.get_child(child_id)
    if child is None:
        return _not_found("宝宝档案不存在")
    return child


@router.post("/children", status_code=201)
def create_child(data: CreateChild):
    return growth_store.create_child(data)


@router.put("/children/{child_id}")
def update_child(child_id: str, data: UpdateChild):
    child = growth_store.update_child(child_id, data)
    if child is None:
        return _not_found("宝宝档案不存在")
    return child


@router.delete("/children/{child_id}")
def delete_child(child_id: str):
    ok = growth_store.delete_child(child_id)
    if not ok:
        return _not_found("宝宝档案不存在")
    return {"success": True}


# ===============================================================
# 成长记录 CRUD
# ===============================================================

@router.post("/children/{child_id}/records", status_code=201)
def add_record(child_id: str, data: CreateGrowthRecord):
    record = growth_store.add_record(child_id, data)
    if record is None:
        return _not_found("宝宝档案不存在")
    return record


@router.put("/children/{child_id}/records/{record_id}")
def update_record(child_id: str, record_id: str, data: UpdateGrowthRecord):
    record = growth_store.update_record(child_id, record_id, data)
    if record is None:
        return _not_found("记录不存在")
    return record


@router.delete("/children/{child_id}/records/{record_id}")
def delete_record(child_id: str, record_id: str):
    ok = growth_store.delete_record(child_id, record_id)
    if not ok:
        return _not_found("记录不存在")
    return {"success": True}


# ===============================================================
# 图表数据
# ===============================================================

@router.get("/children/{child_id}/chart-data")
def chart_data(child_id: str, metric: str = "weight"):
    child = growth_store.get_child(child_id)
    if child is None:
        return _not_found("宝宝档案不存在")

    birth = datetime.strptime(child.birthDate, "%Y-%m-%d")
    data_points = []
    for r in child.records:
        # 只取该 metric 有正数值的记录（getattr 兼容 headCircumference 等驼峰字段）
        value = getattr(r, metric, None)
        if value is None or value <= 0:
            continue
        record_date = datetime.strptime(r.date, "%Y-%m-%d")
        age_months = (record_date.year - birth.year) * 12 + (record_date.month - birth.month)
        data_points.append({"ageMonths": age_months, "date": r.date, "value": value})

    data_points.sort(key=lambda p: p["ageMonths"])
    return {
        "metric": metric,
        "childId": child.childId,
        "childName": child.name,
        "dataPoints": data_points,
    }


# ===============================================================
# AI 健康分析（SSE）
# ===============================================================

ANALYSIS_PROMPT = """你是一位资深的儿科医生和儿童发育专家。请基于以下宝宝成长数据，生成一份专业的健康分析报告。

报告要求：
1. 用温暖鼓励的语气，先肯定父母的用心记录
2. 分析生长趋势（身高、体重、头围等）
3. 给出营养和作息建议
4. 如有需要注意的异常趋势，委婉提醒
5. 使用 Markdown 格式，分段清晰，适当使用 emoji
6. 最后加上一句免责声明：以上为AI初步分析，如有疑虑请咨询儿科医生"""


@router.post("/children/{child_id}/analysis")
async def analysis(child_id: str, request: Request):
    child = growth_store.get_child(child_id)
    if child is None:
        return _not_found("宝宝档案不存在")
    if not child.records:
        return JSONResponse(status_code=400, content={"error": "没有成长记录，无法分析", "code": "NO_RECORDS"})

    # 按日期升序构建记录摘要文本
    records_summary_lines = []
    for r in sorted(child.records, key=lambda r: r.date):
        parts = [f"📅 {r.date}"]
        if r.height:
            parts.append(f"身高: {r.height}cm")
        if r.weight:
            parts.append(f"体重: {r.weight}kg")
        if r.headCircumference:
            parts.append(f"头围: {r.headCircumference}cm")
        if r.sleepDuration:
            parts.append(f"睡眠: {r.sleepDuration}h")
        if r.diapers is not None:
            parts.append(f"尿布: {r.diapers}次")
        if r.feeding:
            parts.append(f"喂养: {r.feeding.type} {r.feeding.amount or ''}{r.feeding.unit or ''}")
        if r.notes:
            parts.append(f"备注: {r.notes}")
        records_summary_lines.append(" | ".join(parts))
    records_summary = "\n".join(records_summary_lines)

    user_message = f"""宝宝信息：
- 姓名: {child.name}
- 性别: {'男' if child.gender == 'male' else '女'}
- 出生日期: {child.birthDate}
- 记录数量: {len(child.records)} 条

成长记录：
{records_summary}

请分析以上数据，生成健康报告。"""

    messages = [
        ChatMessage(role="system", content=ANALYSIS_PROMPT),
        ChatMessage(role="user", content=user_message),
    ]

    async def gen():
        # 复用带熔断 + 中断 + 降级的流式生成器，token 包装成 SSE 事件（对齐 chat 流式格式）
        async for chunk in generate_stream_with_interrupt_and_fallback(messages, request):
            yield f"event: token\ndata: {json.dumps({'text': chunk}, ensure_ascii=False)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
