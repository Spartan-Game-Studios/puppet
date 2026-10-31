import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Plain static files in out/: host anywhere. No middleware, so i18n routes
  // are always prefixed (/en/, /ru/, /zh-CN/, /es/) and / redirects client-side.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default withMDX(config);
