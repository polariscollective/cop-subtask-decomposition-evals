/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // The compare view moved to the root when it became the public landing
      // page. Keep the old path working so existing bookmarks and links —
      // including ones already shared outside the team — don't break.
      { source: "/compare", destination: "/", permanent: true },
    ];
  },
};
export default nextConfig;
