import { getSessionEmail } from "../../auth";
import ScenariosList from "../components/ScenariosList";

export default async function ScenariosPage() {
  const userEmail = await getSessionEmail();
  return <ScenariosList userEmail={userEmail} />;
}
