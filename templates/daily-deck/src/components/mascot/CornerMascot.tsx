import type React from 'react';
import { getMascotProfile } from '../../mascots/mascotRegistry';
import type { PresetMascotId } from '../../schema/newsSchema';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { SafeMedia } from '../guard/SafeMedia';

/** 右下角形象角标组件入参属性 */
export interface CornerMascotProps {
  mascotId: PresetMascotId;
  customMascotUrl?: string | null;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

/** 右下角形象角标：在安全留白区展示紧凑立绘，并在切换角色时播放轻快弹性入场 */
export const CornerMascot: React.FC<CornerMascotProps> = ({
  mascotId,
  customMascotUrl,
  onErrorCaptured,
}) => {
  if (mascotId === 'none' && !customMascotUrl) {
    return null;
  }

  const profile = getMascotProfile(mascotId);
  const src = customMascotUrl || profile.assetUrl;
  if (!src) {
    return null;
  }

  return (
    <div className="corner-mascot-dock" aria-hidden="true">
      <DeckErrorBoundary
        scopeName="corner-mascot"
        fallback={null}
        onErrorCaptured={onErrorCaptured}
      >
        <div key={src} className="corner-mascot-entry">
          <div className="corner-mascot-float">
            <SafeMedia
              src={src}
              alt={profile.name}
              className="corner-mascot-img"
              fallback={
                <div className="corner-mascot-monogram" data-testid="corner-mascot-fallback">
                  {profile.monogram || 'AI'}
                </div>
              }
            />
          </div>
        </div>
      </DeckErrorBoundary>
    </div>
  );
};
