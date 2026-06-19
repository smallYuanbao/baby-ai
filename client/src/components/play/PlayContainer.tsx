/**
 * @file PlayContainer
 * @description Top-level container for the Play section of the baby-ai app.
 *              Manages the active sub-mode (menu, story, riddle, or babytalk)
 *              and renders the corresponding child component alongside a
 *              shared animated mascot whose mood changes based on context.
 */

import { useState } from 'react';
import { PlayMenu } from './PlayMenu';
import { MascotAnimation } from './MascotAnimation';
import { StoryTime } from './StoryTime';
import { RiddleGame } from './RiddleGame';
import { BabyTalk } from './BabyTalk';
import styles from './PlayContainer.module.less';

/** Union of all available play sub-modes the user can navigate between. */
type PlayMode = 'menu' | 'story' | 'riddle' | 'babytalk';

/**
 * PlayContainer
 *
 * Renders the play hub: a persistent mascot animation at the top and a
 * mode-switched content area below. The component keeps track of the
 * currently active sub-mode via local state and renders one of four
 * child components — `PlayMenu`, `StoryTime`, `RiddleGame`, or `BabyTalk`.
 *
 * When a child component requests a back-navigation, the mode resets to
 * `'menu'` so the user returns to the main play hub.
 */
export function PlayContainer() {
  // Tracks which play sub-mode is currently active. Defaults to the menu.
  const [mode, setMode] = useState<PlayMode>('menu');

  // Shared back handler: any child can call this to return to the main menu.
  const handleBack = () => setMode('menu');

  return (
    <div className={styles.wrapper}>
      {/* Animated mascot area — mood varies based on whether we are on the menu or inside a game. */}
      <div className={styles.mascotArea}>
        <MascotAnimation mood={mode === 'menu' ? 'happy' : 'thinking'} />
      </div>

      {/* Conditionally render the active sub-mode component. */}
      {mode === 'menu' && <PlayMenu onSelect={setMode} />}
      {mode === 'story' && <StoryTime onBack={handleBack} />}
      {mode === 'riddle' && <RiddleGame onBack={handleBack} />}
      {mode === 'babytalk' && <BabyTalk onBack={handleBack} />}
    </div>
  );
}
