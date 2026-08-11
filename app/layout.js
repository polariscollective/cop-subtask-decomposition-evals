import "./globals.css";
import { auth, getSessionEmail, signOut } from "../auth";
import TopBar from "./components/TopBar";

export const metadata = {
  title: "Decomposition scenario runner",
};

export default async function RootLayout({ children }) {
  // Two different questions: who am I acting as (which the local-dev
  // bypass can answer without a session), and is there a real session to
  // sign out of. Showing the identity from getSessionEmail keeps the bar
  // honest in local dev, where every route already acts as that email.
  const session = await auth();
  const email = await getSessionEmail();
  // The work-in-progress notice is for the public view only — signed-in team
  // members already know what state this is in. Read on the server so the URL
  // never has to be a NEXT_PUBLIC_* variable.
  const researchDirectionUrl = process.env.RESEARCH_DIRECTION_URL?.trim() || null;

  return (
    <html lang="en">
      <body>
        <TopBar notice={!email} researchDirectionUrl={researchDirectionUrl}>
          {email ? (
            <>
              <span>Signed in as {email}</span>
              {session?.user ? (
                <form
                  action={async () => {
                    "use server";
                    await signOut({ redirectTo: "/" });
                  }}
                >
                  <button type="submit" className="btn btn-ghost">
                    Sign out
                  </button>
                </form>
              ) : (
                <span className="badge badge-warn">local dev — sign-in bypassed</span>
              )}
            </>
          ) : (
            // Only ever reachable on "/", the public compare view — every other
            // page redirects there before this renders. It's the way back in for
            // a team member who lands on the public view, and it returns them to
            // "/", which then shows every run instead of only published ones.
            <>
              <span>Viewing public results</span>
              <a className="btn btn-ghost" href="/api/auth/signin?callbackUrl=%2F">
                Sign in
              </a>
            </>
          )}
        </TopBar>
        {children}
      </body>
    </html>
  );
}
