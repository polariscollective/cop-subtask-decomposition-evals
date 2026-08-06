import fs from "fs";
import path from "path";
import yaml from "js-yaml";

const SCENARIOS_DIR = path.join(process.cwd(), "scenarios");

export function listScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".yaml"));
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8");
    const doc = yaml.load(raw);
    return { file, scenario_id: doc.scenario_id, title: doc.title };
  });
}

export function loadScenario(scenarioId) {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8");
    const doc = yaml.load(raw);
    if (doc.scenario_id === scenarioId) return doc;
  }
  throw new Error(`Scenario not found: ${scenarioId}`);
}

// Convert a tool entry from the YAML spec into an Anthropic tool definition,
// using either the "real" or "test" framing description.
export function toolToAnthropicSchema(tool, framing) {
  const properties = {};
  const required = [];
  for (const [key, val] of Object.entries(tool.input)) {
    required.push(key);
    if (Array.isArray(val)) {
      properties[key] = { type: "array", items: { type: "string" } };
    } else if (val === "boolean") {
      properties[key] = { type: "boolean" };
    } else if (val === "integer") {
      properties[key] = { type: "integer" };
    } else {
      properties[key] = { type: "string" };
    }
  }
  return {
    name: tool.name,
    description: tool.description[framing],
    input_schema: { type: "object", properties, required },
  };
}
