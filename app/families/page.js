import { getSessionEmail } from "../../auth";
import FamiliesList from "../components/FamiliesList";

// Public — see lib/public-paths.js. Same thin server wrapper as app/page.js,
// and for the same reason: the list shows a smaller set of rows and one fewer
// section to a signed-out visitor, and resolving that on the client would mean
// flashing the signed-in view first.
export default async function FamiliesPage() {
  const email = await getSessionEmail();
  return <FamiliesList signedIn={Boolean(email)} />;
}
