/**
 * @fileoverview GrowthContainer — 生长记录模块的顶层容器组件。
 *
 * 职责：
 * - 管理“当前选中宝宝”的状态（selectedChild）以及子视图模式（列表/曲线/分析）。
 * - 当未选中任何宝宝时渲染 ChildSelector 供用户选择或创建宝宝。
 * - 选中宝宝后展示工具栏、视图切换标签和对应子视图，
 *   并提供 GrowthRecordForm 弹窗用于新增或编辑生长记录。
 */

import { useState } from 'react';
import { ChildSelector } from './ChildSelector';
import { GrowthRecordForm } from './GrowthRecordForm';
import { GrowthRecordList } from './GrowthRecordList';
import { GrowthChart } from './GrowthChart';
import { GrowthAnalysis } from './GrowthAnalysis';
import type { Child, GrowthRecord } from '../../types/growth';
import styles from './GrowthContainer.module.less';

/** 视图模式：列表视图 / 生长曲线图 / AI 分析 */
type ViewMode = 'list' | 'chart' | 'analysis';

/**
 * GrowthContainer 组件
 *
 * 作为 growth 模块的路由级容器，持有模块级状态并根据状态驱动子组件渲染。
 * 组件树概览：
 * - 未选中宝宝 → ChildSelector
 * - 已选中宝宝 → 工具栏 (toolbar) + 视图切换 (viewToggle) + 子视图 + 可选的录入表单弹窗
 *
 * @returns 生长记录模块的完整页面结构
 */
export function GrowthContainer() {
  // ---- 模块级状态 ----
  /** 当前选中的宝宝；null 表示尚未选择 */
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);
  /** 当前激活的子视图：列表 / 曲线 / 分析 */
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  /** 是否展示录入表单弹窗 */
  const [showForm, setShowForm] = useState(false);
  /** 当前正在编辑的记录；null 表示新增模式 */
  const [editingRecord, setEditingRecord] = useState<GrowthRecord | null>(null);

  // ---- 无选中宝宝：渲染选择器 ----
  if (!selectedChild) {
    return (
      <div className={styles.wrapper}>
        <ChildSelector
          selectedChild={selectedChild}
          onSelect={setSelectedChild}
        />
      </div>
    );
  }

  // ---- 事件处理 ----

  /** 打开新增记录表单（清空编辑缓存） */
  const handleAddRecord = () => {
    setEditingRecord(null);
    setShowForm(true);
  };

  /** 打开编辑记录表单（填入待编辑记录） */
  const handleEditRecord = (record: GrowthRecord) => {
    setEditingRecord(record);
    setShowForm(true);
  };

  /** 关闭表单并清理编辑缓存 */
  const handleFormClose = () => {
    setShowForm(false);
    setEditingRecord(null);
  };

  /** 表单保存成功后的回调：关闭表单并清空编辑缓存 */
  const handleFormSaved = () => {
    setShowForm(false);
    setEditingRecord(null);
  };

  return (
    <div className={styles.wrapper}>
      {/* ---- 顶部操作栏 ---- */}
      <div className={styles.toolbar}>
        {/* 第一行：返回按钮、宝宝姓名、记录数 */}
        <div className={styles.toolbarRow}>
          <button
            onClick={() => setSelectedChild(null)}
            className={styles.backButton}
          >
            ← 切换宝宝
          </button>
          <span className={styles.childName}>
            {selectedChild.name}
          </span>
          <span className={styles.recordCount}>
            {selectedChild.records?.length || 0} 条记录
          </span>
        </div>

        {/* 第二行：视图切换标签（记录 / 曲线 / 分析） */}
        <div className={styles.viewToggle}>
          {([
            { key: 'list', label: '记录' },
            { key: 'chart', label: '曲线' },
            { key: 'analysis', label: '分析' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setViewMode(key)}
              className={`${styles.viewTab} ${viewMode === key ? styles.active : styles.inactive}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- 视图内容区 ---- */}
      <div className={styles.content}>
        {/* 列表视图：展示记录并支持新增/编辑 */}
        {viewMode === 'list' && (
          <GrowthRecordList
            records={selectedChild.records || []}
            onAdd={handleAddRecord}
            onEdit={handleEditRecord}
          />
        )}
        {/* 曲线视图：WHO 生长标准曲线对比 */}
        {viewMode === 'chart' && (
          <GrowthChart childId={selectedChild.childId} childName={selectedChild.name} />
        )}
        {/* 分析视图：AI 驱动的生长评估 */}
        {viewMode === 'analysis' && (
          <GrowthAnalysis childId={selectedChild.childId} childName={selectedChild.name} />
        )}
      </div>

      {/* ---- 录入表单弹窗（新增 / 编辑） ---- */}
      {showForm && (
        <GrowthRecordForm
          childId={selectedChild.childId}
          record={editingRecord}
          onClose={handleFormClose}
          onSaved={handleFormSaved}
        />
      )}
    </div>
  );
}
