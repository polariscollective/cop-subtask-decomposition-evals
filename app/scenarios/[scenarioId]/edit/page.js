import { getSessionEmail } from "../../../../auth";
import EditScenarioForm from "../../../components/EditScenarioForm";

export default async function EditScenarioPage({ params }) {
  const userEmail = await getSessionEmail();
  return <EditScenarioForm scenarioId={params.scenarioId} userEmail={userEmail} />;
}
