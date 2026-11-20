/**
 * @file main.tsx
 * @description Application entry point for the baby-ai client.
 *
 * This file bootstraps the React application by:
 * 1. Creating a React root on the DOM element with id "root".
 * 2. Rendering the top-level <App /> component wrapped in React.StrictMode,
 *    which activates additional development-time checks (e.g., double-invoking
 *    render functions, detecting side-effects in deprecated lifecycle methods).
 * 3. Importing the global Less stylesheet to ensure base styles, resets, and
 *    CSS custom properties are available across the entire component tree.
 *
 * It is intentionally minimal — all routing, state management, and feature
 * composition is delegated to the <App /> component and its children.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { antdTheme } from './theme';
import './styles/global.less';

// Mount the React application into the DOM.
// The non-null assertion (!) is safe here because index.html is guaranteed to
// contain a <div id="root"></div> — if it is missing, this is a hard failure
// that should be caught immediately during development.
ReactDOM.createRoot(document.getElementById('root')!).render(
  // React.StrictMode enables additional runtime checks in development builds
  // only. It does not affect production behaviour.
  <React.StrictMode>
    {/*
      ConfigProvider 负责把主题（见 src/theme.ts）注入整棵组件树。
      locale 用 zhCN：antd 内置文案（日期选择器的月份、分页的「上一页」等）
      默认是英文，中文应用必须换掉。

      外面再包一层 antd 的 <App>：它提供 message / notification / Modal 的
      静态方法上下文。**不加这层的话，后面用 `message.success(...)` 会拿不到主题**
      （静态 API 不走 React context），弹出的是 antd 默认的冷蓝样式。
      目前还没有用到 message，但这是后续最该补的一块（全项目现在零 toast）。
    */}
    <ConfigProvider theme={antdTheme} locale={zhCN}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>
);
