// Shared "is this a real, allowed person" check. auth.js's Google sign-in
// gate uses this directly; app/api/compare/route.js uses it too, to keep
// QA/test accounts (e.g. reviewer-verify@example.com) out of the
// model-comparison view without a second definition of "allowed" to drift
// out of sync with the login gate.
function parseList(envVar) {
  return (envVar || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const allowedEmails = parseList(process.env.ALLOWED_EMAILS);
const allowedDomains = parseList(process.env.ALLOWED_DOMAINS);

export function isAllowedEmail(email) {
  const normalized = (email || "").trim().toLowerCase();
  if (!normalized) return false;
  if (allowedEmails.includes(normalized)) return true;
  const domain = normalized.split("@")[1];
  return Boolean(domain && allowedDomains.includes(domain));
}
