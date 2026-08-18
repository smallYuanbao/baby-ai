"""
成长记录模块的数据模型（Pydantic）

## 为什么字段名用驼峰（birthDate / childId）而不是 Python 惯例的蛇形？

这些模型直接对齐前端 `client/src/types` 里的 TypeScript 契约（从原 Express
后端的 Zod schema 迁移而来）。前端 `api.ts` 已经按驼峰字段发送/读取，例如：
  - 请求体：`{ name, birthDate, gender }`
  - 响应体：`{ childId, recordCount, lastRecordDate }`

保持驼峰字段名可以让前端零改动接入，代价是后端代码不严格遵循 PEP8 的蛇形
命名。这是「契约一致性优先」的务实取舍。

## 校验边界（对照原 Zod schema）

WHO 0-5 岁儿童生长标准范围：
  - 身高 height：30-180 cm
  - 体重 weight：1-100 kg
  - 头围 headCircumference：20-80 cm
  - 睡眠 sleepDuration：0-24 h
  - 尿布 diapers：0-50 次/天
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class Feeding(BaseModel):
    """单次喂养记录"""
    type: Literal["breast", "formula", "solid", "mixed"]
    amount: Optional[float] = None
    unit: Optional[Literal["ml", "oz", "g", "次"]] = None
    notes: Optional[str] = Field(None, max_length=200)


class CreateChild(BaseModel):
    """新建宝宝档案的请求体"""
    name: str = Field(..., min_length=1, max_length=50)
    birthDate: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    gender: Literal["male", "female"]


class UpdateChild(BaseModel):
    """更新宝宝档案（部分更新，字段全可选）"""
    name: Optional[str] = Field(None, min_length=1, max_length=50)
    birthDate: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    gender: Optional[Literal["male", "female"]] = None


class CreateGrowthRecord(BaseModel):
    """新增成长记录的请求体（除 date 外均可选）"""
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    height: Optional[float] = Field(None, ge=30, le=180)
    weight: Optional[float] = Field(None, ge=1, le=100)
    headCircumference: Optional[float] = Field(None, ge=20, le=80)
    sleepDuration: Optional[float] = Field(None, ge=0, le=24)
    feeding: Optional[Feeding] = None
    diapers: Optional[int] = Field(None, ge=0, le=50)
    notes: Optional[str] = Field(None, max_length=500)


class UpdateGrowthRecord(BaseModel):
    """更新成长记录（部分更新，字段全可选）"""
    date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    height: Optional[float] = Field(None, ge=30, le=180)
    weight: Optional[float] = Field(None, ge=1, le=100)
    headCircumference: Optional[float] = Field(None, ge=20, le=80)
    sleepDuration: Optional[float] = Field(None, ge=0, le=24)
    feeding: Optional[Feeding] = None
    diapers: Optional[int] = Field(None, ge=0, le=50)
    notes: Optional[str] = Field(None, max_length=500)


class GrowthRecord(CreateGrowthRecord):
    """持久化后的成长记录（含服务端生成的 id + createdAt）"""
    id: str
    createdAt: str


class Child(BaseModel):
    """宝宝完整档案（含全部成长记录）"""
    childId: str
    name: str
    birthDate: str
    gender: Literal["male", "female"]
    records: list[GrowthRecord] = []
    createdAt: str
    updatedAt: str


class ChildSummary(BaseModel):
    """列表页用的轻量投影（不含 records，带统计字段）"""
    childId: str
    name: str
    birthDate: str
    gender: Literal["male", "female"]
    recordCount: int
    lastRecordDate: Optional[str] = None
