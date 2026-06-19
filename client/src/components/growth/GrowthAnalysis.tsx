/**
 * @file GrowthAnalysis 组件
 * @description 儿童成长数据分析与展示组件。支持通过 SSE 流式调用后端 AI 服务，
 *              生成个性化的儿童健康分析报告，并以内联 Markdown 形式渲染展示。
 *              包含三个核心状态阶段：初始引导、流式生成中、结果展示与重新生成。
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { consumeSSEStream } from '../../services/sse';
import { api } from '../../services/api';
import { Button } from '../shared/Button';
import styles from './GrowthAnalysis.module.less';

/**
 * GrowthAnalysis 组件的 Props 定义
 */
interface GrowthAnalysisProps {
  /** 儿童唯一标识，用于向后端请求该儿童的成长数据 */
  childId: string;
  /** 儿童名称，用于界面文案中的个性化展示 */
  childName: string;
}

/**
 * 成长数据分析组件
 *
 * 功能流程：
 * 1. 显示引导界面，提示用户可生成 AI 分析报告
 * 2. 用户点击生成后，通过 SSE 流式接收 AI 分析文本并逐步渲染
 * 3. 生成完成后展示完整报告，并提供重新生成入口
 *
 * @param props - 组件属性
 * @param props.childId - 目标儿童 ID
 * @param props.childName - 目标儿童名称
 */
export function GrowthAnalysis({ childId, childName }: GrowthAnalysisProps) {
  // ---- 状态管理 ----

  /** 流式返回的分析文本内容（Markdown 格式） */
  const [content, setContent] = useState('');
  /** 是否正在生成分析报告 */
  const [generating, setGenerating] = useState(false);
  /** 错误信息，null 表示无错误 */
  const [error, setError] = useState<string | null>(null);
  /** 是否已完成过一次生成（用于控制界面阶段切换） */
  const [hasGenerated, setHasGenerated] = useState(false);

  // ---- 事件处理 ----

  /**
   * 发起成长分析报告生成请求
   *
   * 通过 API 获取 SSE 流式响应，逐 token 更新 content 内容。
   * 处理三种 SSE 事件类型：token（增量文本）、done（生成完成）、error（异常中断）。
   */
  const handleGenerate = async () => {
    // 开始生成：开启 loading 态、清空之前的结果和错误
    setGenerating(true);
    setError(null);
    setContent('');

    try {
      // 向后端发起分析请求，返回 ReadableStream 用于 SSE 消费
      const response = await api.growth.requestAnalysis(childId);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || '请求失败');
      }

      // 逐事件消费 SSE 流
      for await (const event of consumeSSEStream(response)) {
        if (event.event === 'token') {
          // 增量追加分析文本
          setContent((prev) => prev + ((event.data as { text: string })?.text || ''));
        } else if (event.event === 'done') {
          // 流式生成正常结束
          setHasGenerated(true);
        } else if (event.event === 'error') {
          // 后端在流中报告的错误
          throw new Error((event.data as any)?.message || '分析失败');
        }
      }
    } catch (err: any) {
      setError(err.message || '生成分析报告失败');
    } finally {
      setGenerating(false);
    }
  };

  // ---- 渲染 ----

  return (
    <div className={styles.wrapper}>
      {/* 阶段一：初始引导 —— 未生成且非加载中时展示 */}
      {!hasGenerated && !generating && (
        <div className={styles.promptSection}>
          <span className={styles.promptIcon}>🤖</span>
          <h4 className={styles.promptTitle}>AI 健康分析</h4>
          <p className={styles.promptDesc}>
            基于 {childName} 的成长记录，AI 儿科专家为你生成个性化健康报告
          </p>
          <Button onClick={handleGenerate}>
            ✨ 生成分析报告
          </Button>
        </div>
      )}

      {/* 阶段二：流式生成中 */}
      {generating && (
        <div>
          {/* 生成状态提示栏 */}
          <div className={styles.generatingHeader}>
            <span className={styles.spinIcon}>🤖</span>
            <span className={styles.generatingText}>AI 正在分析 {childName} 的成长数据...</span>
          </div>
          <div className={styles.resultBox}>
            {content ? (
              // 已有部分内容时，实时渲染 Markdown
              <div className={`markdown-content ${styles.markdownBody}`}>
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            ) : (
              // 尚无内容时，展示加载动画（三点弹跳）
              <div className={styles.bounceDots}>
                <span className={`${styles.bounceDot} animate-bounce-dot`} />
                <span className={`${styles.bounceDot} animate-bounce-dot`} style={{ animationDelay: '0.16s' }} />
                <span className={`${styles.bounceDot} animate-bounce-dot`} style={{ animationDelay: '0.32s' }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 阶段三：生成完成 —— 展示完整报告并提供重新生成按钮 */}
      {hasGenerated && content && (
        <div>
          <div className={styles.resultBox}>
            <div className={`markdown-content ${styles.markdownBody}`}>
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          </div>
          <div className={styles.regenSection}>
            <Button variant="secondary" onClick={handleGenerate} disabled={generating}>
              🔄 重新生成
            </Button>
          </div>
        </div>
      )}

      {/* 错误状态 —— 显示错误信息及重试按钮 */}
      {error && (
        <div className={styles.errorSection}>
          <p className={styles.errorText}>{error}</p>
          <Button variant="secondary" onClick={handleGenerate}>重试</Button>
        </div>
      )}
    </div>
  );
}
