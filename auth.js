import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { isAllowedEmail } from "./lib/allowed-email.js";

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  providers: [Google],
  callbacks: {
    async signIn({ user }) {
      return isAllowedEmail(user.email);
    },
  },
});

// Local-dev convenience: when LOCAL_AUTHENTICATION_NEEDED=false, every
// request is treated as signed in as LOCAL_AUTHENTICATION_EMAIL, skipping
// real Google OAuth — lets tooling (and developers) exercise
// session-gated routes without a live browser login. Hard-gated to
// non-production regardless of the flag's value, so this can never
// activate on a deployed instance.
export async function getSessionEmail() {
  if (process.env.NODE_ENV !== "production" && process.env.LOCAL_AUTHENTICATION_NEEDED === "false") {
    return process.env.LOCAL_AUTHENTICATION_EMAIL || null;
  }
  const session = await auth();
  return session?.user?.email || null;
}
