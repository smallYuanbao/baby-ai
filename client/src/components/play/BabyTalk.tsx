/**
 * @file BabyTalk.tsx
 * @description "婴语翻译"（Baby Talk Interpreter）页面组件。
 * 用户输入宝宝月龄和表现描述，由后端 AI 解读宝宝可能想表达的意思，
 * 并以 Markdown 格式展示解读结果。
 * @module components/play/BabyTalk
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { usePlay } from '../../hooks/usePlay';
import { Button } from '../shared/Button';
import styles from './BabyTalk.module.less';

/**
 * BabyTalk 组件的 props。
 * @interface BabyTalkProps
 */
interface BabyTalkProps {
  /** 返回上一页的回调函数 */
  onBack: () => void;
}

/**
 * BabyTalk 组件 — 婴语翻译功能的主界面。
 *
 * 提供两个视图：
 * 1. 表单视图：选择宝宝月龄、输入宝宝表现描述，点击按钮发起翻译。
 * 2. 结果视图：展示 AI 返回的 Markdown 解读结果，并提供"再翻译一个"按钮。
 *
 * @param {BabyTalkProps} props - 组件属性
 * @param {() => void} props.onBack - 返回上一页的回调
 * @returns {JSX.Element} 婴语翻译页面
 */
export function BabyTalk({ onBack }: BabyTalkProps) {
  // 从 play 上下文中获取 interpretBabyTalk 方法
  const { interpretBabyTalk } = usePlay();

  // ---- 状态管理 ----

  /** 用户输入的宝宝表现描述文本 */
  const [description, setDescription] = useState('');

  /** 宝宝月龄，默认 6 个月 */
  const [babyAge, setBabyAge] = useState(6);

  /** AI 解读结果（Markdown 字符串），为空时展示表单 */
  const [result, setResult] = useState('');

  /** 是否正在等待 AI 返回结果 */
  const [loading, setLoading] = useState(false);

  /**
   * 触发婴语翻译。
   * 调用 `interpretBabyTalk` 将描述文本和月龄发给后端 AI，
   * 返回的解读内容以 Markdown 格式展示。
   * 描述为空时直接返回，不发起请求。
   */
  const handleInterpret = async () => {
    // 空内容不做处理
    if (!description.trim()) return;

    setLoading(true);
    setResult('');

    // 调用 AI 解读接口
    const interpretation = await interpretBabyTalk(description.trim(), babyAge);
    if (interpretation) setResult(interpretation);

    setLoading(false);
  };

  return (
    <div className={styles.wrapper}>
      {/* ---- 顶部导航栏 ---- */}
      <div className={styles.topBar}>
        <button onClick={onBack} className={styles.backButton}>← 返回</button>
        <h3 className={styles.screenTitle}>👶 婴语翻译</h3>
        {/* 占位元素，用于 flex 居中标题 */}
        <div className={styles.spacer} />
      </div>

      <div className={styles.content}>
        {/* 尚未获得结果时展示输入表单 */}
        {!result ? (
          <div className={styles.formSection}>
            {/* 月龄选择 */}
            <div>
              <label className={styles.label}>宝宝月龄</label>
              <select
                value={babyAge}
                onChange={(e) => setBabyAge(parseInt(e.target.value))}
                className={styles.select}
              >
                {/* 常见月龄选项：0–36 个月 */}
                {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 24, 36].map((m) => (
                  <option key={m} value={m}>{m} 个月</option>
                ))}
              </select>
            </div>

            {/* 表现描述输入 */}
            <div>
              <label className={styles.label}>描述宝宝的表现</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="如：宝宝发出咕噜咕噜的声音，一直蹬腿，脸还有点红..."
                rows={4}
                className={styles.textarea}
              />
            </div>

            {/* 翻译按钮：loading 中或描述为空时禁用 */}
            <Button onClick={handleInterpret} disabled={loading || !description.trim()} className={styles.fullWidth}>
              {loading ? '🔍 解读中...' : '🔍 翻译婴语'}
            </Button>
          </div>
        ) : (
          // 已有结果时展示解读内容
          <div className={`${styles.resultSection} animate-fade-in`}>
            {/* 结果卡片：以 Markdown 渲染 AI 返回的解读 */}
            <div className={styles.resultCard}>
              <div className={`markdown-content ${styles.markdownBody}`}>
                <ReactMarkdown>{result}</ReactMarkdown>
              </div>
            </div>

            {/* 底部操作区：重置状态以重新翻译 */}
            <div className={styles.actions}>
              <Button
                onClick={() => { setResult(''); setDescription(''); }}
                variant="secondary"
                className={styles.fullWidth}
              >
                🔄 再翻译一个
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
