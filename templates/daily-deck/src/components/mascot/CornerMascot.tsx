import React from 'react';
import { getMascotProfile } from '../../mascots/mascotRegistry';
import type { PresetMascotId } from '../../schema/newsSchema';
import { DeckErrorBoundary } from '../guard/DeckErrorBoundary';
import { SafeMedia } from '../guard/SafeMedia';

interface CornerMascotProps {
  mascotId: PresetMascotId;
  customMascotUrl?: string | null;
  onErrorCaptured?: (scopeName: string, message: string) => void;
}

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
      <DeckErrorBoundary scopeName="corner-mascot" fallback={null} onErrorCaptured={onErrorCaptured}>
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
      </DeckErrorBoundary>
    </div>
  );
};
