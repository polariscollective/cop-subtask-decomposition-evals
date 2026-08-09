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

const IO_TYPES = ["string", "boolean", "integer", "array"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function pushError(errors, field, message) {
  errors.push({ field, message });
}

// A field's value is one of: a scalar type string ("string"|"boolean"|"integer"),
// an array-of-string marker (["string"]), or — output schemas only — a
// one-level nested object template ([{ subField: "string", ... }]).
function validateFieldType(val, allowNestedObject) {
  if (typeof val === "string") return IO_TYPES.includes(val);
  if (Array.isArray(val) && val.length === 1) {
    if (typeof val[0] === "string") return IO_TYPES.includes(val[0]);
    if (allowNestedObject && typeof val[0] === "object" && val[0] !== null && !Array.isArray(val[0])) {
      return Object.values(val[0]).every((v) => typeof v === "string" && IO_TYPES.includes(v));
    }
  }
  return false;
}

function validateIOSchema(io, toolName, label, errors, allowNestedObject) {
  if (typeof io !== "object" || io === null || Array.isArray(io) || Object.keys(io).length === 0) {
    pushError(errors, `tools.${toolName}.${label}`, `${label} must be a non-empty object of field -> type`);
    return;
  }
  for (const [key, val] of Object.entries(io)) {
    if (!validateFieldType(val, allowNestedObject)) {
      pushError(errors, `tools.${toolName}.${label}.${key}`, `invalid type for "${key}"`);
    }
  }
}

// Single source of truth for "is this a valid scenario doc" — used by every
// write path (POST/PUT routes, the one-off migration script). Never
// duplicated elsewhere.
export function validateScenarioDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") {
    return { ok: false, errors: [{ field: "root", message: "scenario must be an object" }] };
  }

  if (!isNonEmptyString(doc.scenario_id)) pushError(errors, "scenario_id", "scenario_id is required");
  if (!isNonEmptyString(doc.title)) pushError(errors, "title", "title is required");
  if (!isNonEmptyString(doc.context)) pushError(errors, "context", "context is required");
  if (!isNonEmptyString(doc.goal?.real)) pushError(errors, "goal.real", "goal.real is required");
  if (!isNonEmptyString(doc.goal?.test)) pushError(errors, "goal.test", "goal.test is required");
  if (!isNonEmptyString(doc.critical_tool)) pushError(errors, "critical_tool", "critical_tool is required");

  if (!Array.isArray(doc.tools) || doc.tools.length === 0) {
    pushError(errors, "tools", "at least one tool is required");
  } else {
    const seenNames = new Set();
    for (const tool of doc.tools) {
      if (!isNonEmptyString(tool?.name)) {
        pushError(errors, "tools[].name", "every tool needs a name");
        continue;
      }
      if (seenNames.has(tool.name)) pushError(errors, `tools.${tool.name}.name`, `duplicate tool name "${tool.name}"`);
      seenNames.add(tool.name);
      if (!isNonEmptyString(tool.description?.real)) {
        pushError(errors, `tools.${tool.name}.description.real`, "description.real is required");
      }
      if (!isNonEmptyString(tool.description?.test)) {
        pushError(errors, `tools.${tool.name}.description.test`, "description.test is required");
      }
      validateIOSchema(tool.input, tool.name, "input", errors, false);
      validateIOSchema(tool.output, tool.name, "output", errors, true);
    }
    if (isNonEmptyString(doc.critical_tool) && !seenNames.has(doc.critical_tool)) {
      pushError(errors, "critical_tool", `critical_tool "${doc.critical_tool}" must match one of the tool names`);
    }
  }

  if (!Array.isArray(doc.metrics) || doc.metrics.length === 0) {
    pushError(errors, "metrics", "at least one metric is required");
  } else {
    doc.metrics.forEach((m, i) => {
      if (typeof m !== "object" || m === null || Array.isArray(m) || Object.keys(m).length !== 1) {
        pushError(errors, `metrics[${i}]`, "each metric must be a single { name: type } pair");
        return;
      }
      const [name, type] = Object.entries(m)[0];
      if (!isNonEmptyString(name) || !isNonEmptyString(type)) {
        pushError(errors, `metrics[${i}]`, "metric name and type must be non-empty");
      }
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
