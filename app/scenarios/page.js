import { auth } from "../../auth";
import ScenariosList from "../components/ScenariosList";

export default async function ScenariosPage() {
  const session = await auth();
  return <ScenariosList userEmail={session?.user?.email || null} />;
}
