import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

function parseList(envVar) {
  return (envVar || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const allowedEmails = parseList(process.env.ALLOWED_EMAILS);
const allowedDomains = parseList(process.env.ALLOWED_DOMAINS);

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [Google],
  callbacks: {
    async signIn({ user }) {
      const email = (user.email || "").toLowerCase();
      if (!email) return false;
      if (allowedEmails.includes(email)) return true;
      const domain = email.split("@")[1];
      return Boolean(domain && allowedDomains.includes(domain));
    },
  },
});
