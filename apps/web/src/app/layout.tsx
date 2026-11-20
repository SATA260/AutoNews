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
    // 浏览器扩展（如沉浸式翻译）可能在前端水合前向 html/body 注入自定义属性，仅对根节点属性跳过水合告警
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
