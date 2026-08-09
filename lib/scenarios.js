import { getSupabaseClient } from "./supabase.js";

// PostgREST silently caps an unbounded select at 1000 rows, so a growing
// table would quietly start losing scenarios off the end of the list with
// no error anywhere. Page through explicitly instead.
const PAGE_SIZE = 1000;

export async function listScenarios() {
  const supabase = getSupabaseClient();
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("scenarios")
      .select("scenario_id, title, dilemma_id, created_by, created_at")
      .is("deleted_at", null)
      .order("title", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to list scenarios: ${error.message}`);
    all.push(...data);
    if (data.length < PAGE_SIZE) return all;
  }
}

export async function loadScenario(scenarioId) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("scenarios").select("data").eq("scenario_id", scenarioId).single();
  if (error || !data) throw new Error(`Scenario not found: ${scenarioId}`);
  return data.data;
}

function scalarSchema(type) {
  if (type === "boolean") return { type: "boolean" };
  if (type === "integer") return { type: "integer" };
  return { type: "string" };
}

// Convert a tool entry from the scenario spec into an Anthropic tool
// definition, using either the "real" or "test" framing description.
export function toolToAnthropicSchema(tool, framing) {
  const properties = {};
  const required = [];
  for (const [key, val] of Object.entries(tool.input)) {
    required.push(key);
    if (Array.isArray(val)) {
      // Honour the declared item type — the form lets an author pick
      // ["integer"] or ["boolean"], and hardcoding string here would mean
      // the model never sees the type they chose.
      properties[key] = { type: "array", items: scalarSchema(val[0]) };
    } else {
      properties[key] = scalarSchema(val);
    }
  }
  return {
    name: tool.name,
    description: tool.description[framing],
    input_schema: { type: "object", properties, required },
  };
}

// An array's item type, and every field of a nested object template, must
// be a scalar — "array" is only meaningful as a field's own type, so
// allowing it inside either position would admit array-of-array and other
// shapes nothing downstream (the form, toolToAnthropicSchema, the stub
// generator) knows how to handle.
const SCALAR_TYPES = ["string", "boolean", "integer"];
const IO_TYPES = [...SCALAR_TYPES, "array"];

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
    if (typeof val[0] === "string") return SCALAR_TYPES.includes(val[0]);
    if (allowNestedObject && typeof val[0] === "object" && val[0] !== null && !Array.isArray(val[0])) {
      const fields = Object.values(val[0]);
      return fields.length > 0 && fields.every((v) => typeof v === "string" && SCALAR_TYPES.includes(v));
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

// Strips a validated doc down to exactly the scenario fields, so a request
// body's stray keys never reach storage. Without this, a client could park
// arbitrary content — including a `created_by` that shadows the real
// column for anything that later reads the blob directly — inside the
// stored JSON.
export function normalizeScenarioDoc(doc) {
  return {
    scenario_id: doc.scenario_id,
    dilemma_id: doc.dilemma_id || null,
    title: doc.title,
    context: doc.context,
    goal: { real: doc.goal.real, test: doc.goal.test },
    critical_tool: doc.critical_tool,
    tools: doc.tools.map((t) => ({
      name: t.name,
      description: { real: t.description.real, test: t.description.test },
      input: t.input,
      output: t.output,
    })),
  };
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

  return errors.length ? { ok: false, errors } : { ok: true };
}
