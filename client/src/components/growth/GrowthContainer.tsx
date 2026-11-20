/**
 * @fileoverview GrowthContainer — 生长记录模块的顶层容器组件。
 *
 * 职责：
 * - 挂载 `GrowthProvider`，让整个成长模块的组件共用同一份状态。
 * - 管理子视图模式（列表/曲线/分析）与录入弹窗的开关。
 * - 未选中宝宝时渲染 ChildSelector，选中后展示工具栏、视图切换和各子视图。
 *
 * ## 为什么这里要包一层 Provider
 *
 * 状态实现（`hooks/useGrowthState.ts`）内部是 `useState`，而 `useState` 跟着组件实例走 ——
 * 每个调用点各持一份。之前模块里三个组件各调一次，于是 `addRecord()` 里那句
 * 「刷新 selectedChild」刷新的是**表单自己那份没人渲染的副本**，表现就是
 * 「新增记录后列表不更新，要刷新页面才看得到」。
 *
 * 现在 Provider 在这里调用**一次**状态实现，整棵树通过 `useGrowth()` 读同一份。
 * 拆成 `GrowthContainer`（只挂 Provider）+ `GrowthScreen`（真正的界面）两个组件，
 * 是因为**同一个组件不能既提供又消费自己的 context**。
 */

import { useState } from 'react';
import { SegmentedControl, type SegmentedControlItem } from '../shared/SegmentedControl';
import { GrowthProvider, useGrowth } from '../../contexts/GrowthContext';
import { ChildSelector } from './ChildSelector';
import { GrowthRecordForm } from './GrowthRecordForm';
import { GrowthRecordList } from './GrowthRecordList';
import { GrowthChart } from './GrowthChart';
import { GrowthAnalysis } from './GrowthAnalysis';
import type { GrowthRecord } from '../../types/growth';
import styles from './GrowthContainer.module.less';

/** 视图模式：列表视图 / 生长曲线图 / AI 分析 */
type ViewMode = 'list' | 'chart' | 'analysis';

/** 视图切换的三个选项。抽成常量是因为要在 JSX 里按顺序渲染。 */
const VIEW_MODES: readonly SegmentedControlItem<ViewMode>[] = [
  { key: 'list', label: '记录' },
  { key: 'chart', label: '曲线' },
  { key: 'analysis', label: '分析' },
];

/**
 * 成长模块的入口组件。
 *
 * 只负责把状态 Provider 挂到模块根部，界面交给 `GrowthScreen`。
 *
 * @returns 包了 Provider 的成长模块组件树
 */
export function GrowthContainer() {
  return (
    <GrowthProvider>
      <GrowthScreen />
    </GrowthProvider>
  );
}

/**
 * 成长模块的界面。
 *
 * 从共享状态里读 `selectedChild` —— 它由两个地方写入：ChildSelector 点卡片时的
 * `loadChild()`，以及各 mutation 成功后 hook 内部的自动刷新。因为是同一份 state，
 * 写完立刻反映到这里，不需要手动通知。
 */
function GrowthScreen() {
  const { selectedChild, clearSelectedChild } = useGrowth();

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
        <ChildSelector />
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

  /**
   * 表单保存成功后的回调。
   *
   * 这里**只关表单** —— 数据刷新由 hook 内部的 mutation 完成
   * （`addRecord` / `updateRecord` 成功后都会 `loadChild()`）。
   * 共用同一份状态之后，那次刷新才会真正更新到这个组件渲染的列表。
   */
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
          <button onClick={clearSelectedChild} className={styles.backButton}>
            ← 切换宝宝
          </button>
          <span className={styles.childName}>{selectedChild.name}</span>
          <span className={styles.recordCount}>
            {selectedChild.records?.length || 0} 条记录
          </span>
        </div>

        {/* 第二行：视图切换标签（记录 / 曲线 / 分析） */}
        <SegmentedControl
          items={VIEW_MODES}
          value={viewMode}
          onChange={setViewMode}
          ariaLabel="视图切换"
        />
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
          <GrowthAnalysis
            childId={selectedChild.childId}
            childName={selectedChild.name}
            recordCount={selectedChild.records?.length || 0}
          />
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
