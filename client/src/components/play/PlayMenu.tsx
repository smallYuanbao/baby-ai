/**
 * PlayMenu — 玩法选择菜单组件
 *
 * 展示可选的三种互动模式（讲故事、猜谜语、婴语翻译），
 * 用户点击后通过 onSelect 回调将选中模式传递给父组件。
 *
 * @module components/play/PlayMenu
 */

import styles from './PlayMenu.module.less';

/** 支持的玩法模式类型 */
type PlayMode = 'story' | 'riddle' | 'babytalk';

/** PlayMenu 组件的 props */
interface PlayMenuProps {
  /** 选中某个玩法模式时的回调 */
  onSelect: (mode: PlayMode) => void;
}

/** 菜单项静态配置：包含模式标识、图标、标题、描述及对应的样式类名 */
const MENU_ITEMS: { mode: PlayMode; icon: string; title: string; desc: string; cardClass: string }[] = [
  {
    mode: 'story',
    icon: '📖',
    title: '讲故事',
    desc: 'AI 为宝宝创作专属故事',
    cardClass: 'cardStory',
  },
  {
    mode: 'riddle',
    icon: '🧩',
    title: '猜谜语',
    desc: '趣味谜语 + 提示 + 得分',
    cardClass: 'cardRiddle',
  },
  {
    mode: 'babytalk',
    icon: '👶',
    title: '婴语翻译',
    desc: '描述宝宝行为，AI 趣味解读',
    cardClass: 'cardBabytalk',
  },
];

/**
 * 玩法选择菜单
 *
 * 渲染三个模式卡片按钮，点击后触发 onSelect 回调传出选中的 PlayMode。
 *
 * @param props - 组件属性
 * @param props.onSelect - 选中模式时的回调函数
 */
export function PlayMenu({ onSelect }: PlayMenuProps) {
  return (
    <div className={styles.wrapper}>
      {MENU_ITEMS.map((item) => (
        <button
          key={item.mode}
          onClick={() => onSelect(item.mode)}
          className={`${styles.menuItem} ${styles[item.cardClass]}`}
        >
          {/* 箭头放右上角：卡片改成竖排后，"右端"不再是一条可以用 margin-left:auto 推的轴 */}
          <span className={styles.menuArrow} aria-hidden="true">→</span>
          <span className={styles.menuIcon}>{item.icon}</span>
          <h3 className={styles.menuTitle}>{item.title}</h3>
          <p className={styles.menuDesc}>{item.desc}</p>
        </button>
      ))}
    </div>
  );
}
