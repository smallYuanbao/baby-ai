/**
 * Header — App shell top bar.
 *
 * Renders the global site header with the app logo (a teddy-bear SVG mascot),
 * app title, and a subtitle. On the right edge it hosts a user switcher
 * (方案 A 轻量鉴权 demo)：切换 API Key 即切换「当前登录用户」，用于演示
 * 服务端多租户隔离——不同用户看不到彼此的宝宝档案 / 上传文件。
 */

import { useState } from 'react';
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

  /**
   * 切换登录用户：更新 api 层的 key 并刷新页面，
   * 让各容器重新以新身份拉取数据（隔离边界在服务端）。
   */
  const handleSwitch = (key: string) => {
    setApiKey(key);
    setCurrentKey(key);
    window.location.reload();
  };

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
        {/* 用户切换：方案 A 轻量鉴权 demo 的入口 */}
        <select
          className={styles.userSwitcher}
          value={currentKey}
          onChange={(e) => handleSwitch(e.target.value)}
          aria-label="切换登录用户"
        >
          {USERS.map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
