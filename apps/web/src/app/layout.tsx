import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI 每日报控制台',
  description: 'AI 每日报自动化视频工作流后台管理与审校平台',
};

/** 网页后台全局根布局组件 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
