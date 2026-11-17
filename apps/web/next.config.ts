import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: '11mb' } },
  serverExternalPackages: [
    '@aidaily/core',
    '@aidaily/cli-bridge',
    '@aidaily/tts',
    'playwright',
    'jsdom',
    'pino',
  ],
};

export default nextConfig;
