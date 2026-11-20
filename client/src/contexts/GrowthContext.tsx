/**
 * @file GrowthContext.tsx
 * @description 成长模块的**共享状态入口**。
 *
 * ## 为什么需要这一层
 *
 * 状态实现（`hooks/useGrowthState.ts`）内部用的是 `useState`，而**`useState` 是跟着
 * 组件实例走的**：同一个 hook 被三个组件各调一次，就会得到三份互不相干的 state。
 *
 * 之前成长模块就是这么用的，于是「新增记录后列表不更新」：
 *
 *   GrowthContainer   自己 useState 存 selectedChild  ← 列表渲染的是这份，选宝宝时设一次，之后永不更新
 *   ChildSelector     调一次 useGrowth()              ← 又一份；而且它绕过 hook 直接调了 api.getChild
 *   GrowthRecordForm  调一次 useGrowth()              ← 第三份；addRecord 里那句「刷新 selectedChild」
 *                                                        刷的就是这份没人渲染的副本，所以是个空操作
 *
 * 结果：只有整页刷新（重新拉数据）才能看到新记录。
 *
 * 现在由 `<GrowthProvider>` 在组件树顶上调用**一次** `useGrowthState()`，把返回值放进
 * context；所有子组件通过 `useGrowth()` 读同一份。`addRecord` 里那句刷新才真正生效。
 *
 * ## 用法
 *
 * Provider 挂在成长模块的根部（见 `GrowthContainer`），子组件直接用：
 *
 * ```tsx
 * import { useGrowth } from '../../contexts/GrowthContext';
 *
 * const { selectedChild, loadChild, addRecord } = useGrowth();
 * ```
 *
 * @module contexts/GrowthContext
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useGrowthState } from '../hooks/useGrowthState';

/**
 * context 里装的东西 = `useGrowthState()` 的返回值。
 * 用 `ReturnType` 推导而不是手写一遍接口，这样 hook 增删字段时这里自动跟上，不会漂移。
 */
type GrowthContextValue = ReturnType<typeof useGrowthState>;

/**
 * 默认值是 `null` 而不是一个"空对象"：
 * 空对象会让"忘了包 Provider"表现为各种莫名其妙的 undefined 报错，
 * 而 `null` 能在 `useGrowth()` 里被明确识别并抛出可读的错误。
 */
const GrowthContext = createContext<GrowthContextValue | null>(null);

/**
 * 成长模块的状态提供者。
 *
 * 在组件树顶上调用一次 `useGrowthState()` 并把结果共享给所有后代。
 * **不要嵌套多层** —— 每套一层就会多出一份独立的 state，等于把刚修掉的 bug 又做回来。
 *
 * @param props.children - 成长模块的组件树
 */
export function GrowthProvider({ children }: { children: ReactNode }) {
  const value = useGrowthState();
  return <GrowthContext.Provider value={value}>{children}</GrowthContext.Provider>;
}

/**
 * 读取成长模块的共享状态。
 *
 * 必须在 `<GrowthProvider>` 内部使用 —— 在外部调用会抛错而不是静默拿到空数据，
 * 因为「静默拿到空数据」这种失败方式会把问题拖到很远的地方才暴露。
 *
 * @returns `useGrowthState()` 的完整返回值（state + 全部 mutation）
 * @throws 当前组件树里没有 `<GrowthProvider>` 时抛出
 */
export function useGrowth(): GrowthContextValue {
  const value = useContext(GrowthContext);
  if (!value) {
    throw new Error(
      'useGrowth() 必须在 <GrowthProvider> 内部使用。' +
        '成长模块的 Provider 挂在 GrowthContainer 根部（见 contexts/GrowthContext.tsx）。',
    );
  }
  return value;
}
