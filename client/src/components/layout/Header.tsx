/**
 * Header — App shell top bar.
 *
 * Renders the global site header with the app logo (a teddy-bear SVG mascot),
 * app title, and a subtitle. On the right edge it hosts a user switcher
 * (方案 A 轻量鉴权 demo)：切换 API Key 即切换「当前登录用户」，用于演示
 * 服务端多租户隔离——不同用户看不到彼此的宝宝档案 / 上传文件。
 */

import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { LoadingState } from '../shared/LoadingState';
import { getCurrentUserKey, setApiKey } from '../../services/api';
import styles from './Header.module.less';

/**
 * 预置用户，与后端 `app/core/auth.py` 的 API_KEYS 一一对应。
 * 每个 key 映射到一个 user_id；切换 key 后所有请求带上新 key，
 * 服务端据此过滤数据，从而演示隔离效果。
 */
const USERS: { key: string; label: string }[] = [
  { key: 'dev-key-alice', label: '👩 Alice' },
  { key: 'dev-key-bob', label: '👨 Bob' },
];

/**
 * App header — branding bar with logo, copy, and a user switcher.
 */
export function Header() {
  const [currentKey, setCurrentKey] = useState(getCurrentUserKey());
  /** 是否正在切换用户（切换会整页刷新，见 handleSwitch 的说明）。 */
  const [switching, setSwitching] = useState(false);

  /**
   * 切换登录用户。
   *
   * 实现上是**整页刷新**：api key 存在模块级变量里，改它不会触发任何 React 更新，
   * 各容器的数据也就不会重新拉。刷新是最省事的做法，但代价是**刷新期间应用内完全没有反馈**
   * —— 页面直接白掉，只有浏览器自己的那个小转圈，用户不知道发生了什么。
   *
   * 所以先切到一个"正在切换"的全屏遮罩，**等它真的画出来之后**再刷新。
   * 刷新动作放在 effect 里而不是直接调用：effect 在提交并绘制之后才跑，
   * 直接调 reload 会抢在渲染前执行，遮罩根本来不及显示。
   */
  const handleSwitch = (key: string) => {
    if (key === currentKey) return;   // 选中的还是当前用户，不必刷新
    setApiKey(key);
    setCurrentKey(key);
    setSwitching(true);
  };

  useEffect(() => {
    if (!switching) return;
    // **必须给一点延时，否则遮罩等于没有。**
    // React 的 effect 在提交并绘制之后才跑，所以遮罩确实会被画出来 —— 但紧接着
    // 浏览器就跳走了，它只存在一帧（~16ms），用户眼里就是"页面直接白了"。
    // 400ms 是让人能看清"正在切换用户"这句话、又不至于觉得卡的时长。
    const timer = setTimeout(() => window.location.reload(), 400);
    return () => clearTimeout(timer);
  }, [switching]);

  return (
    <header className={styles.header}>
      <div className={styles.container}>
        {/* AI teddy-bear mascot — inline SVG to avoid an extra network round-trip */}
        <div className={styles.avatar}>
          <svg viewBox="0 0 100 100" className={styles.avatarSvg}>
            {/* Head — large circle at the bottom */}
            <circle cx="50" cy="55" r="28" fill="#fff7ed" />
            {/* Left ear */}
            <circle cx="28" cy="32" r="12" fill="#fff7ed" />
            {/* Right ear */}
            <circle cx="72" cy="32" r="12" fill="#fff7ed" />
            {/* Left ear inner */}
            <circle cx="28" cy="32" r="6" fill="#fdba74" />
            {/* Right ear inner */}
            <circle cx="72" cy="32" r="6" fill="#fdba74" />
            {/* Left eye */}
            <circle cx="40" cy="52" r="4" fill="#1a1a2e" />
            {/* Right eye */}
            <circle cx="60" cy="52" r="4" fill="#1a1a2e" />
            {/* Nose */}
            <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />
            {/* Mouth — quadratic bezier smile */}
            <path d="M40 70 Q50 78 60 70" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <h1 className={styles.title}>育儿AI助手</h1>
          <p className={styles.subtitle}>用科学知识陪伴宝宝成长 🧸</p>
        </div>
        {/*
          用户切换：方案 A 轻量鉴权 demo 的入口。

          从原生 `<select>` 换成 antd `Select`，原因是**原生的展开列表根本没法用 CSS 控制** ——
          外框能靠 appearance:none 自绘，但点开后的那层弹层是浏览器/系统画的：
          深色底、蓝色高亮、系统圆角，跟这套暖色设计完全不是一路（截图里非常突兀）。
        */}
        <Select
          className={styles.userSwitcher}
          value={currentKey}
          onChange={handleSwitch}
          options={USERS.map((u) => ({ value: u.key, label: u.label }))}
          size="small"
          aria-label="切换登录用户"
          // 弹层宽度跟内容走，不要被撑成跟触发器一样宽
          popupMatchSelectWidth={false}
        />
      </div>

      {/* 切换用户时的全屏遮罩：刷新是整页级的，所以覆盖层也要铺满整个视口 */}
      {switching && (
        <div className={styles.switchOverlay}>
          <LoadingState text="正在切换用户，重新加载数据…" />
        </div>
      )}
    </header>
  );
}
