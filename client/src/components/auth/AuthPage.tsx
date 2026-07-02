/**
 * Auth page — login / register toggle.
 *
 * Renders the auth card with a tab switcher. When a user successfully
 * authenticates, the AuthContext state updates and the parent (App)
 * automatically switches from this page to the main app content.
 */

import { useState } from 'react';
import { LoginForm } from './LoginForm';
import { RegisterForm } from './RegisterForm';
import styles from './Auth.module.less';

type AuthMode = 'login' | 'register';

export function AuthPage() {
  const [mode, setMode] = useState<AuthMode>('login');

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {/* Logo / branding */}
        <div className={styles.brand}>
          <svg viewBox="0 0 100 100" className={styles.logo}>
            <circle cx="50" cy="55" r="28" fill="#fff7ed" />
            <circle cx="28" cy="32" r="12" fill="#fff7ed" />
            <circle cx="72" cy="32" r="12" fill="#fff7ed" />
            <circle cx="28" cy="32" r="6" fill="#fdba74" />
            <circle cx="72" cy="32" r="6" fill="#fdba74" />
            <circle cx="40" cy="52" r="4" fill="#1a1a2e" />
            <circle cx="60" cy="52" r="4" fill="#1a1a2e" />
            <ellipse cx="50" cy="62" rx="5" ry="3.5" fill="#f97316" />
            <path d="M40 70 Q50 78 60 70" stroke="#f97316" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          </svg>
          <h1 className={styles.title}>育儿AI助手</h1>
          <p className={styles.subtitle}>用科学知识陪伴宝宝成长 🧸</p>
        </div>

        {/* Tab switcher */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${mode === 'login' ? styles.tabActive : ''}`}
            onClick={() => setMode('login')}
          >
            登录
          </button>
          <button
            className={`${styles.tab} ${mode === 'register' ? styles.tabActive : ''}`}
            onClick={() => setMode('register')}
          >
            注册
          </button>
        </div>

        {/* Form */}
        {mode === 'login' ? <LoginForm /> : <RegisterForm />}
      </div>
    </div>
  );
}
