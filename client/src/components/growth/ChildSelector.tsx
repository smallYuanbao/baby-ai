/**
 * ChildSelector 组件
 *
 * 成长记录模块的子组件，用于展示已有宝宝列表并提供添加新宝宝的表单。
 * 支持：
 * - 加载并展示宝宝列表（头像、姓名、出生日期、记录数）
 * - 点击宝宝卡片进入该宝宝的成长记录详情
 * - 删除宝宝及其所有关联记录
 * - 通过表单创建新宝宝（姓名、出生日期、性别）
 *
 * @module ChildSelector
 */

import { useState, useEffect } from 'react';
import { useGrowth } from '../../hooks/useGrowth';
import { api } from '../../services/api';
import { Button } from '../shared/Button';
import { Spinner } from '../shared/Spinner';
import type { Child } from '../../types/growth';
import styles from './ChildSelector.module.less';

/**
 * ChildSelector 组件的属性
 */
interface ChildSelectorProps {
  /** 当前选中的宝宝，可为 null 表示未选择 */
  selectedChild: Child | null;
  /** 选中宝宝时的回调，传入被选中的 Child 对象 */
  onSelect: (child: Child) => void;
}

/**
 * 宝宝选择器组件
 *
 * 渲染成长记录模块的入口视图：展示已创建的宝宝列表，并提供创建新宝宝的折叠表单。
 * 首次挂载时自动加载宝宝列表，加载中显示 Spinner。
 *
 * @param props - 组件属性，仅解构使用 onSelect 回调
 * @returns 加载骨架或完整的宝宝选择 UI
 */
export function ChildSelector({ onSelect }: ChildSelectorProps) {
  const { children, loading, loadChildren, createChild, deleteChild } = useGrowth();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [submitting, setSubmitting] = useState(false);

  // 组件挂载时自动拉取宝宝列表
  useEffect(() => {
    loadChildren();
  }, [loadChildren]);

  /**
   * 提交创建新宝宝
   * - 校验姓名和出生日期非空
   * - 创建成功后自动选中该宝宝并重置表单
   * - 错误由 useGrowth hook 内部统一处理（toast）
   */
  const handleCreate = async () => {
    if (!name.trim() || !birthDate) return;
    setSubmitting(true);
    try {
      const child = await createChild({ name: name.trim(), birthDate, gender });
      if (child) {
        onSelect(child);
        setShowForm(false);
        setName('');
        setBirthDate('');
      }
    } catch { /* hook 已处理错误 */ }
    setSubmitting(false);
  };

  /**
   * 选中某个宝宝：通过 API 获取完整 Child 对象后回调父组件
   */
  const handleSelect = async (childId: string) => {
    try {
      const child = await api.growth.getChild(childId);
      onSelect(child);
    } catch { /* ignore */ }
  };

  // 初始加载中且尚无缓存数据时，展示居中加载骨架
  if (loading && children.length === 0) {
    return (
      <div className={styles.loading}>
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>📈</span>
        <h2 className={styles.title}>成长记录</h2>
        <p className={styles.subtitle}>记录宝宝每一步成长</p>
      </div>

      {/* 宝宝列表 */}
      {children.length > 0 && (
        <div className={styles.list}>
          {children.map((child) => (
            <button
              key={child.childId}
              onClick={() => handleSelect(child.childId)}
              className={styles.childCard}
            >
              <div className={styles.childCardInner}>
                <div className={styles.childInfo}>
                  <span className={styles.childAvatar}>
                    {child.gender === 'male' ? '👦' : '👧'}
                  </span>
                  <div>
                    <h3 className={styles.childName}>{child.name}</h3>
                    <p className={styles.childMeta}>
                      🎂 {child.birthDate} · {child.recordCount} 条记录
                    </p>
                  </div>
                </div>
                {/* 内层删除按钮：stopPropagation 防止冒泡触发外层卡片的选中 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`确定删除 ${child.name} 的所有记录？`)) {
                      deleteChild(child.childId);
                    }
                  }}
                  className={styles.deleteButton}
                  title="删除"
                >
                  🗑
                </button>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 添加宝宝 */}
      {!showForm ? (
        <Button variant="secondary" onClick={() => setShowForm(true)} className={styles.fullWidth}>
          + 添加宝宝
        </Button>
      ) : (
        <div className={`${styles.formPanel} animate-slide-up`}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="宝宝名字（如：小豆豆）"
            className={styles.formInput}
          />
          <div>
            <label className={styles.formLabel}>出生日期</label>
            <input
              type="date"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              className={styles.formInput}
            />
          </div>
          {/* 性别切换：根据当前 gender 状态高亮对应按钮 */}
          <div className={styles.genderToggle}>
            <button
              onClick={() => setGender('male')}
              className={`${styles.genderOption} ${gender === 'male' ? styles.maleActive : styles.maleInactive}`}
            >
              👦 男孩
            </button>
            <button
              onClick={() => setGender('female')}
              className={`${styles.genderOption} ${gender === 'female' ? styles.femaleActive : styles.femaleInactive}`}
            >
              👧 女孩
            </button>
          </div>
          <div className={styles.formActions}>
            <Button variant="ghost" onClick={() => setShowForm(false)} className={styles.flex1}>取消</Button>
            <Button onClick={handleCreate} disabled={submitting || !name.trim() || !birthDate} className={styles.flex1}>
              {submitting ? '创建中...' : '确认创建'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
