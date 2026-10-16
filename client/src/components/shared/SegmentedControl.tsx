/**
 * SegmentedControl — 分段控件：一组互斥选项，点击切换。
 *
 * 两种外观（`variant`）：
 *   - `pill`（默认）：有轨道底色的药丸组，给**主级**导航用（记录 / 曲线 / 分析）；
 *   - `underline`：纯文字 + 选中项下划线，给**子级**选项用（体重 / 身高 / 头围）。
 *
 * 为什么要有第二种：成长页原来上下摆着两排**一模一样**的药丸组，用户的原话是
 * "看起来有两个 Tab 在一起"。同一种控件叠两层，无论怎么调大小都还是同一种东西；
 * 换成下划线标签是换了个"种类"，层级一眼分得开。
 *
 * 这个组件本身也是从两处**逐字重复**的 CSS 里抽出来的（`GrowthContainer` 的
 * `.viewToggle/.viewTab` 和 `GrowthChart` 的 `.metricToggle/.metricTab`），
 * 那两份当时已经出现了 `align-items` / `margin` 的分歧 —— 典型的"复制粘贴必然漂移"。
 *
 * @file   client/src/components/shared/SegmentedControl.tsx
 */

import styles from './SegmentedControl.module.less';

/** 单个选项。`key` 是回传给 `onChange` 的标识，`label` 是显示文案。 */
export interface SegmentedControlItem<T extends string> {
  key: T;
  label: string;
}

/** 外观变体。见文件头说明。 */
export type SegmentedControlVariant = 'pill' | 'underline';

interface SegmentedControlProps<T extends string> {
  /** 全部选项，顺序即展示顺序。 */
  items: readonly SegmentedControlItem<T>[];
  /** 当前选中的 key。 */
  value: T;
  /** 选中项变化时回调。 */
  onChange: (key: T) => void;
  /**
   * 这组标签的用途，读屏软件会念出来（如「视图切换」「指标切换」）。
   * 必填 —— 抽成组件后如果不强制，调用方很容易忘了传。
   */
  ariaLabel: string;
  /** 外观；默认 `pill`（主级）。 */
  variant?: SegmentedControlVariant;
}

/**
 * 渲染一组互斥的分段标签。
 *
 * @param props - 见 {@link SegmentedControlProps}。
 * @returns 分段控件元素。
 *
 * @example
 * ```tsx
 * // 主级：药丸组
 * <SegmentedControl items={VIEW_MODES} value={view} onChange={setView} ariaLabel="视图切换" />
 *
 * // 子级：下划线标签
 * <SegmentedControl items={METRICS} value={metric} onChange={setMetric}
 *                   ariaLabel="指标切换" variant="underline" />
 * ```
 */
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  variant = 'pill',
}: SegmentedControlProps<T>) {
  const isUnderline = variant === 'underline';

  // 提前算好类名，省得 JSX 里嵌三层三元
  const trackClass = isUnderline ? styles.underlineTrack : styles.track;
  const tabClass = isUnderline ? styles.underlineTab : styles.pillTab;
  const activeClass = isUnderline ? styles.activeUnderline : styles.active;

  return (
    // role="group" + aria-pressed 是「切换按钮组」的标准写法。
    // 没用 tablist/tab：那套还要求 aria-controls 指向 tabpanel 并实现方向键导航，
    // 在这里属于过度设计；group + aria-pressed 已经把"这是一组开关、哪个开着"说清楚了。
    <div className={trackClass} role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const isActive = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(item.key)}
            className={`${styles.tab} ${tabClass} ${isActive ? activeClass : ''}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
