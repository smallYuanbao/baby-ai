/**
 * antd 主题桥接 —— 把项目的设计 token 喂给 antd。
 *
 * ## 为什么必须有这个文件
 *
 * antd 的默认设计语言和本项目**四项视觉基因全都相反**：
 *
 * | | antd 默认 | 本项目 |
 * |---|---|---|
 * | 主色 | 冷蓝 `#1677ff` | 暖橙 `#f97316` |
 * | 圆角 | `6px` | 最小 16px |
 * | 字体 | 系统字体栈 | `Nunito` |
 * | 正文字号 | `14px` | `16px` |
 *
 * 不映射直接引入，页面上会出现两套设计语言打架 —— 比不用组件库还难看。
 *
 * ## 值的唯一来源
 *
 * 下面每个值都必须取自 `src/styles/variables.less`，注释里标出对应的 Less 变量名。
 * **不要在两边各写一份**：改配色时只改 variables.less，然后回来同步这里
 * （两边不一致时，表现为「自研组件是暖橙、antd 组件是另一个橙」这种细微但刺眼的偏差）。
 */

import type { ThemeConfig } from 'antd';

/** 与 `variables.less` 的 `@font-sans` 保持一致。 */
const FONT_SANS = "'Nunito', 'Noto Sans SC', system-ui, sans-serif";

/**
 * antd 的主题配置。
 *
 * 用法见 `main.tsx`：`<ConfigProvider theme={antdTheme} locale={zhCN}>`。
 */
export const antdTheme: ThemeConfig = {
  token: {
    // ── 品牌 ───────────────────────────────────────────────
    colorPrimary: '#f97316', // @primary-500

    // ── 形状：本项目的圆角风格偏大，antd 默认 6px 会明显突变 ──
    borderRadius: 16, // @radius-xl (1rem)

    // ── 字体与密度：antd 默认 14px 正文 + 32px 控件高度，
    //    都比本项目（16px 正文、间距基准 16px）更紧 ──────────
    fontFamily: FONT_SANS, // @font-sans
    fontSize: 16, // @text-base
    controlHeight: 40, // 默认 32 偏小

    // ── 表面与文字（alias 层，同样可以直接覆盖）────────────
    colorBgContainer: '#ffffff', // @white      面板 / 卡片
    colorBgLayout: '#fdf4ea', // @surface-light 页面底（暖白）
    colorText: '#1f2937', // @gray-800
    colorTextSecondary: '#4b5563', // @gray-600
    colorBorder: '#e5e7eb', // @gray-200

    // ── 语义色 ─────────────────────────────────────────────
    // 取 @red-700 而不是 @red-500：前者是专门给「错误文字」用的那档，
    // 在暖白底上对比度 5.95:1 过 AA；@red-500 只有 3.46:1（见 variables.less 的说明）。
    colorError: '#b91c1c', // @red-700
  },

  components: {
    // 表单 label 单独调小一档。
    //
    // 起因：为了对齐本项目的正文（16px），上面把 seed 的 `fontSize` 从 antd 默认的
    // 14 抬到了 16。副作用是**表单 label 也跟着变成 16px**，于是它和输入框里的内容
    // 同色（都是 colorText）、同号（16）、同字重（400）—— 完全分不出哪个是标签。
    //
    // 实测（浏览器计算样式）：
    //   修复前  label: 16px/400/#1f2937   输入文字: 16px/400/#1f2937   ← 一模一样
    //
    // 这里把 label 压回 14px 并加深一档，与 16px 的输入内容拉开层次。
    // 字重在 antd 里**没有对应 token**，只能靠 global.less 里那条补丁（见该文件
    // 「antd 兼容补丁」一节）。
    Form: {
      labelFontSize: 14,
      labelColor: '#111827', // @gray-900，比输入文字的 @gray-800 再深一档
    },
  },
};
