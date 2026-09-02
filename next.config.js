/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // This is a register that handles payment. It should never be loadable
  // inside someone else's frame, where a "Cash" button can be positioned under
  // an invisible overlay and clicked by a visitor who thinks they are clicking
  // something else. The rest are the cheap, no-downside headers.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
