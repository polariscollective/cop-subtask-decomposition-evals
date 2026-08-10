// The root is a public page (see middleware.js's PUBLIC_PATHS), so it is
// reachable by anyone with the link — deliberately. Being reachable is not
// the same as being indexed: a published run exposes its whole stored blob,
// including free-text descriptions and full model transcripts, and none of
// that should turn up in search results. Reversible whenever that changes.
export default function robots() {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
