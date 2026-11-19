import type React from 'react';
import { useState } from 'react';
import type { ResolvedCompanyVisual } from '../../logos/companyRegistry';
import { SafeMedia } from '../guard/SafeMedia';

/** 公司 Logo 徽章组件入参属性 */
export interface CompanyLogoBadgeProps {
  company: ResolvedCompanyVisual;
  size: 'card' | 'item';
}

/** 渲染公司或机构 Logo；当暂无图标文件或图标加载异常时直接切换为带品牌色的首字母徽章 */
export const CompanyLogoBadge: React.FC<CompanyLogoBadgeProps> = ({ company, size }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const effectiveLogoUrl =
    company.logoUrl && failedUrl !== company.logoUrl ? company.logoUrl : null;

  if (!effectiveLogoUrl) {
    return (
      <span
        className={`company-logo-monogram is-${size}`}
        style={{ '--logo-accent': company.accentColor } as React.CSSProperties}
        aria-hidden="true"
      >
        {company.monogram}
      </span>
    );
  }

  return (
    <span className={`company-logo-badge is-${size}`} title={company.displayName}>
      <SafeMedia
        src={effectiveLogoUrl}
        alt={company.displayName}
        className="company-logo-img"
        onFallback={() => setFailedUrl(effectiveLogoUrl)}
        fallback={null}
      />
    </span>
  );
};
