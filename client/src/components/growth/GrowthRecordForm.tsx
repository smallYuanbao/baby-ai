/**
 * GrowthRecordForm – 成长记录表单组件
 *
 * 以底部面板（Bottom Sheet）形式呈现，支持添加新记录和编辑已有记录。
 * 覆盖身高、体重、头围、睡眠、喂养、尿布、备注等成长指标。
 *
 * 数据流：
 * - 新建模式：childId + EMPTY_FORM → useGrowth().addRecord
 * - 编辑模式：childId + record (GrowthRecord | null) → useGrowth().updateRecord
 *
 * @module GrowthRecordForm
 */

import { useState } from 'react';
import { useGrowth } from '../../hooks/useGrowth';
import type { GrowthRecord } from '../../types/growth';
import styles from './GrowthRecordForm.module.less';

/**
 * GrowthRecordForm 组件的 props
 */
interface GrowthRecordFormProps {
  /** 当前宝宝的唯一标识 */
  childId: string;
  /** 编辑模式下传入的已有记录；新建模式下为 null */
  record: GrowthRecord | null;
  /** 关闭面板的回调（点击遮罩层、关闭按钮或取消按钮时触发） */
  onClose: () => void;
  /** 保存成功后的回调，通常用于刷新父组件列表 */
  onSaved: () => void;
}

/** 新建记录时的默认表单初始值 */
const EMPTY_FORM = {
  date: new Date().toISOString().slice(0, 10),
  height: '',
  weight: '',
  headCircumference: '',
  sleepDuration: '',
  diapers: '',
  feedingType: 'breast' as string,
  feedingAmount: '',
  feedingUnit: 'ml',
  notes: '',
};

/**
 * 成长记录表单组件
 *
 * 以受控表单方式收集宝宝成长数据。内部根据 `record` prop 判断模式：
 * - `record` 为 null → 新建模式
 * - `record` 有值 → 编辑模式
 *
 * 提交时将字符串字段转换为数字类型，再调用对应的 hook 方法。
 */
export function GrowthRecordForm({ childId, record, onClose, onSaved }: GrowthRecordFormProps) {
  const { addRecord, updateRecord } = useGrowth();

  // 根据编辑/新建模式初始化表单状态
  const [form, setForm] = useState(
    record
      // 编辑模式：将 GrowthRecord 的数值字段转为字符串，方便 input 绑定
      ? {
          date: record.date,
          height: record.height?.toString() || '',
          weight: record.weight?.toString() || '',
          headCircumference: record.headCircumference?.toString() || '',
          sleepDuration: record.sleepDuration?.toString() || '',
          diapers: record.diapers?.toString() || '',
          feedingType: record.feeding?.type || 'breast',
          feedingAmount: record.feeding?.amount?.toString() || '',
          feedingUnit: record.feeding?.unit || 'ml',
          notes: record.notes || '',
        }
      : EMPTY_FORM
  );

  // 保存中的 loading 状态，用于禁用按钮防重复提交
  const [saving, setSaving] = useState(false);

  /**
   * 表单提交处理
   *
   * 1. 阻止默认提交行为
   * 2. 将字符串字段按需转换为 number（parseFloat / parseInt）
   * 3. 根据模式调用 addRecord 或 updateRecord
   * 4. 通知父组件保存完成
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    // 构建提交数据，只包含必填字段
    const data: any = {
      date: form.date,
      notes: form.notes || undefined,
    };

    // 仅当有值时添加数值字段，避免提交空字符串
    if (form.height) data.height = parseFloat(form.height);
    if (form.weight) data.weight = parseFloat(form.weight);
    if (form.headCircumference) data.headCircumference = parseFloat(form.headCircumference);
    if (form.sleepDuration) data.sleepDuration = parseFloat(form.sleepDuration);
    if (form.diapers) data.diapers = parseInt(form.diapers, 10);

    // 喂养信息作为嵌套对象提交
    if (form.feedingAmount) {
      data.feeding = {
        type: form.feedingType,
        amount: parseFloat(form.feedingAmount),
        unit: form.feedingUnit,
      };
    }

    try {
      if (record) {
        // 编辑模式：更新已有记录
        await updateRecord(childId, record.id, data);
      } else {
        // 新建模式：添加新记录
        await addRecord(childId, data);
      }
      onSaved();
    } catch { /* hook 已处理错误 */ }

    // 无论成功失败都恢复按钮状态，避免 UI 卡死
    setSaving(false);
  };

  return (
    /* 遮罩层 — 点击关闭面板 */
    <div className={styles.overlay} onClick={onClose}>
      {/* 面板主体 — 阻止事件冒泡，防止点击面板内部时关闭 */}
      <div
        className={`${styles.panel} animate-slide-up`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部区域：标题 + 关闭按钮 */}
        <div className={styles.header}>
          <h3 className={styles.headerTitle}>
            {record ? '编辑记录' : '添加成长记录'}
          </h3>
          <button onClick={onClose} className={styles.closeButton}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {/* 日期 */}
          <div>
            <label className={styles.label}>日期</label>
            <input
              type="date" required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className={styles.input}
            />
          </div>

          {/* 身高 + 体重 — 双列网格布局 */}
          <div className={styles.grid2}>
            <div>
              <label className={styles.label}>身高 (cm)</label>
              <input
                type="number" step="0.1" min="30" max="180"
                value={form.height}
                onChange={(e) => setForm({ ...form, height: e.target.value })}
                placeholder="如: 65.0"
                className={styles.input}
              />
            </div>
            <div>
              <label className={styles.label}>体重 (kg)</label>
              <input
                type="number" step="0.1" min="1" max="100"
                value={form.weight}
                onChange={(e) => setForm({ ...form, weight: e.target.value })}
                placeholder="如: 7.2"
                className={styles.input}
              />
            </div>
          </div>

          {/* 头围 + 睡眠 — 双列网格布局 */}
          <div className={styles.grid2}>
            <div>
              <label className={styles.label}>头围 (cm)</label>
              <input
                type="number" step="0.1" min="20" max="80"
                value={form.headCircumference}
                onChange={(e) => setForm({ ...form, headCircumference: e.target.value })}
                placeholder="如: 42.0"
                className={styles.input}
              />
            </div>
            <div>
              <label className={styles.label}>睡眠 (小时/天)</label>
              <input
                type="number" step="0.5" min="0" max="24"
                value={form.sleepDuration}
                onChange={(e) => setForm({ ...form, sleepDuration: e.target.value })}
                placeholder="如: 14"
                className={styles.input}
              />
            </div>
          </div>

          {/* 喂养 — 三列：类型 / 数量 / 单位 */}
          <div>
            <label className={styles.label}>喂养</label>
            <div className={styles.grid3}>
              <select
                value={form.feedingType}
                onChange={(e) => setForm({ ...form, feedingType: e.target.value })}
                className={styles.select}
              >
                <option value="breast">母乳</option>
                <option value="formula">配方奶</option>
                <option value="solid">辅食</option>
                <option value="mixed">混合</option>
              </select>
              <input
                type="number" step="10" min="0"
                value={form.feedingAmount}
                onChange={(e) => setForm({ ...form, feedingAmount: e.target.value })}
                placeholder="数量"
                className={styles.input}
              />
              <select
                value={form.feedingUnit}
                onChange={(e) => setForm({ ...form, feedingUnit: e.target.value })}
                className={styles.select}
              >
                <option value="ml">ml</option>
                <option value="oz">oz</option>
                <option value="g">g</option>
                <option value="次">次</option>
              </select>
            </div>
          </div>

          {/* 尿布 */}
          <div>
            <label className={styles.label}>尿布更换 (次/天)</label>
            <input
              type="number" min="0" max="50"
              value={form.diapers}
              onChange={(e) => setForm({ ...form, diapers: e.target.value })}
              placeholder="如: 8"
              className={styles.input}
            />
          </div>

          {/* 备注 */}
          <div>
            <label className={styles.label}>备注</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="今天宝宝的特别表现..."
              rows={2}
              className={styles.textarea}
            />
          </div>

          {/* 操作按钮 — 取消 + 保存 */}
          <div className={styles.actions}>
            <button
              type="button"
              onClick={onClose}
              className={styles.cancelButton}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className={styles.saveButton}
            >
              {saving ? '保存中...' : '保存记录'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
