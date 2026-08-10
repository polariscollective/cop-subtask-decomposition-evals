import { getSessionEmail } from "../auth";
import CompareGrid from "./components/CompareGrid";

// The root is public — see middleware.js's PUBLIC_PATHS. This thin server
// wrapper exists only to answer one question before anything renders: is
// there a session? The grid shows a different (smaller) set of controls to a
// signed-out visitor, and resolving that on the client would mean flashing
// the signed-in UI first.
export default async function HomePage() {
  const email = await getSessionEmail();
  return <CompareGrid signedIn={Boolean(email)} />;
}
