/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */

const nextConfig = {
  // output: 'standalone' 仅用于 Docker 部署，Vercel 不需要
  ...(process.env.DOCKER_ENV === 'true' ? { output: 'standalone' } : {}),
  eslint: {
    dirs: ['src'],
    ignoreDuringBuilds: true,
  },

  reactStrictMode: false,
  swcMinify: true,

  // ⚠️ 保持 unoptimized: true，影视站封面图来源多样，
  // 启用 Vercel 图片优化可能超出免费配额（1000次/月），故关闭
  // 已通过 loading="lazy" 实现懒加载优化
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  experimental: {
    // 按需导入大型包，减少首屏 JS bundle 体积
    optimizePackageImports: [
      'lucide-react',
      '@heroicons/react',
      'framer-motion',
      'react-icons',
    ],
  },

  webpack(config) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    return config;
  },
};

// Setup Cloudflare Pages development platform in development mode
if (process.env.NODE_ENV === 'development') {
  const { setupDevPlatform } = require('@cloudflare/next-on-pages/next-dev');
  setupDevPlatform();
}

// 检测是否为云平台构建
const isCloudflarePages =
  process.env.CF_PAGES === '1' ||
  process.env.CLOUDFLARE_PAGES === '1' ||
  process.argv.includes('pages:build');

const isVercel = process.env.VERCEL === '1';
const isNetlify = process.env.NETLIFY === 'true';

// 在所有云平台上禁用 next-pwa，避免与自定义 sw.js 冲突
const isCloudPlatform = isCloudflarePages || isVercel || isNetlify;

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development' || isCloudPlatform,
  register: true,
  skipWaiting: true,
});

module.exports = withPWA(nextConfig);
