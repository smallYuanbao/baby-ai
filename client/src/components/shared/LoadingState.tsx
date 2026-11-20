/**
 * LoadingState — 整块区域加载时的占位。
 *
 * 和裸 `<Spinner />` 的区别：**带一行说明文字**。
 *
 * 起因是反馈「页面切换的时候 loading 看不太出来」——实测下来确实如此：
 * 原来整页加载就是一个 32px 的裸转圈，飘在 1272 × 798 的空白页正中间，
 * 周围没有任何参照物，眼睛一扫就略过去了。加上文字之后：
 *   - 眼睛有了落点；
 *   - 也说明了"在等什么"，用户能区分"在加载"和"卡死了"。
 *
 * 转圈用品牌橙（见 .module.less），中性灰在暖白底上太弱。
 *
 * @file   client/src/components/shared/LoadingState.tsx
 */

import { Spinner } from './Spinner';
import styles from './LoadingState.module.less';

interface LoadingStateProps {
  /**
   * 说明正在加载什么，如「正在加载宝宝档案…」。
   * 写具体一点 —— "加载中"这种放之四海皆准的话等于没说。
   */
  text: string;
}

/**
 * 渲染一个居中的「转圈 + 说明文字」加载态。
 *
 * @param props - 见 {@link LoadingStateProps}。
 * @returns 加载占位元素。
 *
 * @example
 * ```tsx
 * if (loading) return <LoadingState text="正在加载成长曲线…" />;
 * ```
 */
export function LoadingState({ text }: LoadingStateProps) {
  return (
    // role="status" + aria-live：读屏软件会念出这段文字，视觉用户和读屏用户拿到同样的信息
    <div className={styles.wrapper} role="status" aria-live="polite">
      <Spinner size="lg" />
      <p className={styles.text}>{text}</p>
    </div>
  );
}
