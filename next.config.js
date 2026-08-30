/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Don't fail the production build on lint warnings during the hackathon crunch.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
