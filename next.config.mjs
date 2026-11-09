/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },                      // nobody can embed your app in another site
        { key: 'X-Content-Type-Options', value: 'nosniff' },            // browser won't guess file types
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },   // app never needs these
      ],
    }];
  },
};
export default nextConfig;