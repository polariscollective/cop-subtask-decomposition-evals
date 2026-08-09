import "./globals.css";
import { auth, getSessionEmail, signOut } from "../auth";

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

  return (
    <html lang="en">
      <body>
        {email && (
          <div className="auth-bar">
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
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
