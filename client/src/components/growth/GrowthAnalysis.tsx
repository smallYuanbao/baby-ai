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
  /**
   * 该儿童的成长记录条数。
   *
   * 用来在**点之前**就拦住"没有记录还想生成报告"的情况：后端对这种情况返回 400
   * (`{error: "没有成长记录，无法分析"}`)，但那个信息前端本来就有（工具栏就显示着
   * 「0 条记录」），让用户点一下再吃一个报错属于白跑一趟。
   */
  recordCount: number;
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
export function GrowthAnalysis({ childId, childName, recordCount }: GrowthAnalysisProps) {
  // ---- 状态管理 ----

  /**
   * 界面的四种状态，**互斥**。
   *
   * 踩过：原来用的是 `hasGenerated` / `generating` / `error` / `content` 四个独立布尔，
   * 它们并不互斥 —— 生成失败后 `hasGenerated=false && generating=false` 让「阶段一」成立，
   * 同时 `error` 非空让错误块也成立，于是「✨ 生成分析报告」和「重试」**同时**出现在页面上。
   * 换成单一状态机后这种组合在类型上就不存在了。
   */
  type Status = 'idle' | 'generating' | 'done' | 'error';
  const [status, setStatus] = useState<Status>('idle');
  /** 流式返回的分析文本内容（Markdown 格式） */
  const [content, setContent] = useState('');
  /** 错误信息，仅在 status === 'error' 时有意义 */
  const [error, setError] = useState<string | null>(null);

  /** 没有任何成长记录时无法分析 —— 后端会拒，不如前端先拦住。 */
  const noRecords = recordCount === 0;

  // ---- 事件处理 ----

  /**
   * 发起成长分析报告生成请求
   *
   * 通过 API 获取 SSE 流式响应，逐 token 更新 content 内容。
   * 处理三种 SSE 事件类型：token（增量文本）、done（生成完成）、error（异常中断）。
   */
  const handleGenerate = async () => {
    // 开始生成：切到 generating 态、清空之前的结果和错误
    setStatus('generating');
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
          setStatus('done');
        } else if (event.event === 'error') {
          // 后端在流中报告的错误
          throw new Error((event.data as any)?.message || '分析失败');
        }
      }
    } catch (err: any) {
      setError(err.message || '生成分析报告失败');
      setStatus('error');
    }
    // 注意：这里不能再用 finally 统一收尾 —— 成功路径已经迁移到 'done'，
    // 再在 finally 里补一刀会把刚设好的状态又盖掉。
  };

  // ---- 渲染 ----

  return (
    <div className={styles.wrapper}>
      {/* 阶段一：初始引导 */}
      {status === 'idle' && (
        <div className={styles.promptSection}>
          <span className={styles.promptIcon}>🤖</span>
          <h4 className={styles.promptTitle}>AI 健康分析</h4>
          <p className={styles.promptDesc}>
            {noRecords
              ? `还没有 ${childName} 的成长记录。先去「记录」里添加一条，AI 才有数据可分析。`
              : `基于 ${childName} 的成长记录，AI 儿科专家为你生成个性化健康报告`}
          </p>
          <Button onClick={handleGenerate} disabled={noRecords}>
            ✨ 生成分析报告
          </Button>
        </div>
      )}

      {/* 阶段二：流式生成中 */}
      {status === 'generating' && (
        <div>
          {/* 生成状态提示栏 */}
          <div className={styles.generatingHeader}>
            <span className={styles.spinIcon}>🤖</span>
            <span className={styles.generatingText}>AI 正在分析 {childName} 的成长数据...</span>
          </div>
          <div className={styles.resultBox}>
            {content ? (
              // 流式输出中：纯文本渲染，避免逐 token 重复解析 Markdown
              <div className={`markdown-content ${styles.markdownBody}`}>
                {content}
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
      {status === 'done' && (
        <div>
          <div className={styles.resultBox}>
            <div className={`markdown-content ${styles.markdownBody}`}>
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
          </div>
          <div className={styles.regenSection}>
            <Button variant="secondary" onClick={handleGenerate}>
              🔄 重新生成
            </Button>
          </div>
        </div>
      )}

      {/* 阶段四：错误 —— 与其余三个状态互斥，不会和「生成分析报告」同时出现 */}
      {status === 'error' && (
        <div className={styles.errorSection}>
          <p className={styles.errorText}>{error}</p>
          <Button variant="secondary" onClick={handleGenerate}>重试</Button>
        </div>
      )}
    </div>
  );
}
