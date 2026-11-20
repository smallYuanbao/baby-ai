/**
 * @fileoverview 朗读音色 / 语速设置行。
 *
 * 就地展开在聊天工具栏里（和「清空对话」的二次确认是同一套交互模式），
 * 不弹层、不遮挡消息。选择结果由父组件持久化到 localStorage。
 *
 * 下拉框用 antd 的 `Select` 而不是原生 `<select>`：原生控件的**展开列表**
 * 由浏览器/系统绘制，CSS 管不到（深色底、系统蓝高亮），和这套暖色设计不是一路。
 * 同样的替换在 BabyTalk 和 Header 上做过。
 */

import { Select } from 'antd';
import styles from './VoiceSettings.module.less';

interface VoiceSettingsProps {
  /** 浏览器可用的中文音色。 */
  voices: SpeechSynthesisVoice[];
  /** 用户选定的音色名；空串表示自动。 */
  voiceName: string;
  /** 自动挑选时实际会用的音色名，用于提示「自动选择（婷婷）」。 */
  selectedVoiceName: string | null;
  /** 当前语速。 */
  rate: number;
  onVoiceChange: (name: string) => void;
  onRateChange: (value: string) => void;
  onClose: () => void;
}

const RATE_OPTIONS = [
  { value: '0.8', label: '慢' },
  { value: '0.9', label: '稍慢' },
  { value: '1', label: '正常' },
  { value: '1.15', label: '稍快' },
];

/**
 * 音色 + 语速两个下拉 + 完成按钮。
 *
 * @param props - 见 {@link VoiceSettingsProps}。
 */
export function VoiceSettings({
  voices,
  voiceName,
  selectedVoiceName,
  rate,
  onVoiceChange,
  onRateChange,
  onClose,
}: VoiceSettingsProps) {
  return (
    <div className={styles.row}>
      <div className={styles.field}>
        <span className={styles.label}>音色</span>
        <Select
          value={voiceName}
          onChange={onVoiceChange}
          /*
            空值 = 自动。把实际会用的音色 name 显示出来，否则用户不知道
            "自动"到底选中了哪一个，也就无从判断要不要换。
          */
          options={[
            {
              value: '',
              label: `自动选择${selectedVoiceName ? `（${selectedVoiceName}）` : ''}`,
            },
            // 同名音色可能同时存在（如 Eddy 有 zh-CN / zh-TW 两版），
            // 但 value 用 name 才能和 pickChineseVoice 精确匹配
            ...voices.map((v) => ({
              value: v.name,
              label: `${v.name}（${v.lang}）`,
            })),
          ]}
          className={`${styles.select} ${styles.voiceSelect}`}
          size="small"
          popupMatchSelectWidth={false}
          aria-label="朗读音色"
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>语速</span>
        <Select
          value={String(rate)}
          onChange={onRateChange}
          options={RATE_OPTIONS}
          className={`${styles.select} ${styles.rateSelect}`}
          size="small"
          popupMatchSelectWidth={false}
          aria-label="朗读语速"
        />
      </div>

      <button type="button" onClick={onClose} className={styles.done}>
        完成
      </button>
    </div>
  );
}
