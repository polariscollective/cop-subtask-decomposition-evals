import "./globals.css";
import { auth, signOut } from "../auth";

export const metadata = {
  title: "Decomposition scenario runner",
};

export default async function RootLayout({ children }) {
  const session = await auth();

  return (
    <html lang="en">
      <body>
        {session?.user && (
          <div className="auth-bar">
            <span>Signed in as {session.user.email}</span>
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
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
