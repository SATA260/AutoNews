import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
