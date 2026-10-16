/**
 * GrowthRecordForm – 成长记录表单（新增 / 编辑）
 *
 * 用 antd `Modal` + `Form` 实现。覆盖身高、体重、头围、睡眠、喂养、尿布、备注。
 *
 * ## 为什么从自研遮罩换成了 antd Modal
 *
 * 原来是一个自己写的 `div` 遮罩 + 底部面板。换成 antd 之后**顺带补上了一批本该有的行为**，
 * 这些不是"换皮"，是实打实的缺陷修复：
 *
 * | | 自研遮罩（旧） | antd Modal（新） |
 * |---|---|---|
 * | Esc 关闭 | ❌ 没有 keydown 监听 | ✅ 默认支持 |
 * | 焦点陷阱 | ❌ Tab 会跑到遮罩后面 | ✅ 默认支持 |
 * | 挂载位置 | ❌ 原地渲染，靠 `position:fixed` 撑；祖先一加 `transform` 就会被剪切 | ✅ `createPortal` 到 body |
 * | 滚动锁定 | ❌ 没有 | ✅ 默认支持 |
 * | 点遮罩 | ❌ 直接关闭，**已填内容全丢** | ✅ 设了 `maskClosable={false}` |
 * | 无障碍 | ❌ 零 `aria-*` / `role` | ✅ 内建 `role="dialog"` |
 *
 * ## 数据流
 * - 新建：`record = null` → `useGrowth().addRecord`
 * - 编辑：`record` 有值 → `useGrowth().updateRecord`
 *
 * @module GrowthRecordForm
 */

import { useState } from 'react';
import { Button, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useGrowth } from '../../hooks/useGrowth';
import type { GrowthRecord } from '../../types/growth';

/** 表单字段值。`InputNumber` 直接产出 number，不再需要手工 `parseFloat`。 */
interface FormValues {
  date: Dayjs;
  height?: number | null;
  weight?: number | null;
  headCircumference?: number | null;
  sleepDuration?: number | null;
  diapers?: number | null;
  feedingType: string;
  feedingAmount?: number | null;
  feedingUnit: string;
  notes?: string;
}

interface GrowthRecordFormProps {
  /** 当前宝宝的唯一标识 */
  childId: string;
  /** 编辑模式下传入的已有记录；新建模式下为 null */
  record: GrowthRecord | null;
  /** 关闭面板的回调（取消按钮 / 右上角 ✕ / Esc 触发） */
  onClose: () => void;
  /** 保存成功后的回调，通常用于刷新父组件列表 */
  onSaved: () => void;
}

/** 喂养类型的选项（原来是写在 `<select>` 里的四个 `<option>`）。 */
const FEEDING_TYPES = [
  { value: 'breast', label: '母乳' },
  { value: 'formula', label: '配方奶' },
  { value: 'solid', label: '辅食' },
  { value: 'mixed', label: '混合' },
];

/** 喂养量的单位选项。 */
const FEEDING_UNITS = [
  { value: 'ml', label: 'ml' },
  { value: 'oz', label: 'oz' },
  { value: 'g', label: 'g' },
  { value: '次', label: '次' },
];

/**
 * 把 `record`（或"新建"）转成表单初始值。
 *
 * 数值字段不再转成字符串 —— `InputNumber` 直接吃 number。
 * 只要把日期字符串转成 Dayjs（DatePicker 要求）。
 */
function toInitialValues(record: GrowthRecord | null): FormValues {
  if (!record) {
    return {
      date: dayjs(),
      feedingType: 'breast',
      feedingUnit: 'ml',
    };
  }
  return {
    date: dayjs(record.date),
    height: record.height ?? undefined,
    weight: record.weight ?? undefined,
    headCircumference: record.headCircumference ?? undefined,
    sleepDuration: record.sleepDuration ?? undefined,
    diapers: record.diapers ?? undefined,
    feedingType: record.feeding?.type || 'breast',
    feedingAmount: record.feeding?.amount ?? undefined,
    feedingUnit: record.feeding?.unit || 'ml',
    notes: record.notes || '',
  };
}

/**
 * 成长记录表单组件。
 *
 * 由父组件条件渲染（`GrowthContainer` 里的 `{showForm && <GrowthRecordForm/>}`），
 * 所以挂载即打开 —— `open` 恒为 true，关闭时由父组件卸载。
 */
export function GrowthRecordForm({ childId, record, onClose, onSaved }: GrowthRecordFormProps) {
  const { addRecord, updateRecord } = useGrowth();
  const [form] = Form.useForm<FormValues>();

  /** 保存中：禁用按钮防重复提交。 */
  const [saving, setSaving] = useState(false);

  /**
   * 提交（由 antd Form 在校验通过后调用）。
   *
   * 校验（必填日期、数值范围）交给 `Form.Item` 的 rules 和 `InputNumber` 的 min/max，
   * 这里只做数据整形。
   */
  const handleFinish = async (values: FormValues) => {
    setSaving(true);

    const data: any = {
      date: values.date.format('YYYY-MM-DD'),
      notes: values.notes || undefined,
    };

    // 只带上填了的数值字段，避免提交空值。
    // 注意判 `!= null` 而不是真值判断 —— 数字 0 是合法值（比如睡眠 0 小时）。
    if (values.height != null) data.height = values.height;
    if (values.weight != null) data.weight = values.weight;
    if (values.headCircumference != null) data.headCircumference = values.headCircumference;
    if (values.sleepDuration != null) data.sleepDuration = values.sleepDuration;
    if (values.diapers != null) data.diapers = values.diapers;

    if (values.feedingAmount != null) {
      data.feeding = {
        type: values.feedingType,
        amount: values.feedingAmount,
        unit: values.feedingUnit,
      };
    }

    try {
      if (record) {
        await updateRecord(childId, record.id, data);
      } else {
        await addRecord(childId, data);
      }
      onSaved();
    } catch {
      /* hook 内部已处理错误提示 */
    }

    setSaving(false);
  };

  return (
    <Modal
      open
      title={record ? '编辑记录' : '添加成长记录'}
      onCancel={onClose}
      footer={null}
      width={520}
        // antd 6 的 Modal **没有 `top` 这个 prop**（v5 有、v6 移除了），
        // 但 `.ant-modal` 上仍带着 `top: 100px`。用 style 覆盖成更小的值：
        // 日期面板高 361px，加上弹窗内它上方的 182px 内容，100px 的偏移需要
        // 643px 视口才放得下 —— 矮窗口下面板会被顶出屏幕。48px 后 600px 也够。
        style={{ top: 48 }}
      /*
        不加 `centered`：原因同 ChildSelector —— 居中会让日期面板无处可放，
        矮窗口下会向上弹出屏幕（详见该文件里的说明）。
        点遮罩不关闭。原来的自研遮罩是 `onClick={onClose}` —— 填了一半手一滑点到旁边，
        内容直接没了，而且没有任何二次确认。要关就点「取消」或右上角 ✕（Esc 也行）。
      */
      maskClosable={false}
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={toInitialValues(record)}
        onFinish={handleFinish}
        // 关掉 antd 自带的滚动到错误项（弹窗本身不高，滚动会让视野跳动）
        scrollToFirstError={false}
      >
        <Form.Item
          name="date"
          label="日期"
          rules={[{ required: true, message: '请选择日期' }]}
        >
          <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
        </Form.Item>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="height" label="身高 (cm)">
              <InputNumber min={30} max={180} step={0.1} placeholder="如: 65.0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="weight" label="体重 (kg)">
              <InputNumber min={1} max={100} step={0.1} placeholder="如: 7.2" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="headCircumference" label="头围 (cm)">
              <InputNumber min={20} max={80} step={0.1} placeholder="如: 42.0" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="sleepDuration" label="睡眠 (小时/天)">
              <InputNumber min={0} max={24} step={0.5} placeholder="如: 14" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item label="喂养">
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item name="feedingType" noStyle>
                <Select options={FEEDING_TYPES} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="feedingAmount" noStyle>
                <InputNumber min={0} step={10} placeholder="数量" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="feedingUnit" noStyle>
                <Select options={FEEDING_UNITS} />
              </Form.Item>
            </Col>
          </Row>
        </Form.Item>

        <Form.Item name="diapers" label="尿布更换 (次/天)">
          <InputNumber min={0} max={50} placeholder="如: 8" style={{ width: '100%' }} />
        </Form.Item>

        <Form.Item name="notes" label="备注">
          <Input.TextArea rows={2} placeholder="今天宝宝的特别表现..." />
        </Form.Item>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={saving}>
            保存记录
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
