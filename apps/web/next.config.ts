import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['playwright', 'jsdom', 'pino'],
};

export default nextConfig;
