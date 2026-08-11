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
  for (const [key, val] of Object.entries(tool.input || {})) {
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

// How many tools a scenario has. Fixed rather than a minimum: every consumer
// that reads "reached every step" as "made the irreversible call" — the
// public grid most visibly — compares depth against a per-scenario length,
// and a 2-tool scenario would make crossing trivially cheap next to a 5-tool
// one. Four is the shape the harness was built around.
export const REQUIRED_TOOL_COUNT = 4;

// The output field names a later tool can relay from. Includes the subfields
// of an array-of-object output, because a plan pulls those across the array
// with "<step_N.field[].subField>" (see lib/placeholders.js).
function outputFieldNames(output) {
  const names = new Set();
  if (typeof output !== "object" || output === null || Array.isArray(output)) return names;
  for (const [key, val] of Object.entries(output)) {
    names.add(key);
    if (Array.isArray(val) && val.length === 1 && typeof val[0] === "object" && val[0] !== null && !Array.isArray(val[0])) {
      for (const sub of Object.keys(val[0])) names.add(sub);
    }
  }
  return names;
}

// A list-typed input is filled by pulling one scalar across an array-valued
// output, so its natural name is the plural of the field it relays: an input
// "node_ids" is satisfied by a "node_id" subfield. Comparing on the singular
// stem covers that. It is deliberately the only fuzziness allowed — anything
// looser would let unrelated names count as a chain link.
function stem(name) {
  return typeof name === "string" && name.endsWith("s") ? name.slice(0, -1) : name;
}

// For each input field of `tool`, which earlier tools could supply it. A
// field with no candidate is a free parameter: something the model invents
// rather than relays, which is exactly the channel that let a planner soften
// the critical step (it used to be able to pass revoke_old_access: false).
// See docs/FUTURE_WORK.md#f-02.
function relayCandidates(tool, earlierTools) {
  const perField = new Map();
  for (const field of Object.keys(tool?.input || {})) {
    const providers = earlierTools
      .filter((prior) => {
        for (const name of outputFieldNames(prior.output)) {
          if (stem(name) === stem(field)) return true;
        }
        return false;
      })
      .map((prior) => prior.name);
    perField.set(field, providers);
  }
  return perField;
}

// Every tool must sit somewhere on a path into the critical one. Two shapes
// satisfy this and both are wanted: a straight chain (1→2→3→4) and an
// aggregator (1, 2, 3 independent, 4 consuming all three).
//
// Reachability here is permissive: when a field could be relayed from more
// than one earlier tool, every candidate counts as an edge. That is the right
// strictness for a scenario, which only has to make a full chain *possible*
// and leave nothing orphaned. Whether a given plan actually chained through
// everything is a different question, decided against the plan's own
// "<step_N...>" references by makePlanAcceptance in lib/planner.js.
function ancestorsOfCriticalTool(tools, criticalToolName) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const indexOf = new Map(tools.map((t, i) => [t.name, i]));
  const reached = new Set();
  const queue = [criticalToolName];
  while (queue.length) {
    const name = queue.shift();
    const tool = byName.get(name);
    const at = indexOf.get(name);
    if (!tool || at === undefined) continue;
    const earlier = tools.slice(0, at);
    for (const providers of relayCandidates(tool, earlier).values()) {
      for (const provider of providers) {
        if (reached.has(provider)) continue;
        reached.add(provider);
        queue.push(provider);
      }
    }
  }
  return reached;
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
      // The first tool declares no input, and a YAML author writes that as an
      // absent key rather than an empty mapping. Storing {} keeps every
      // reader — toolToAnthropicSchema, the scenario form — off the
      // undefined path.
      input: t.input || {},
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

  if (!Array.isArray(doc.tools) || doc.tools.length !== REQUIRED_TOOL_COUNT) {
    pushError(
      errors,
      "tools",
      `exactly ${REQUIRED_TOOL_COUNT} tools are required (got ${Array.isArray(doc.tools) ? doc.tools.length : 0})`
    );
  } else {
    const seenNames = new Set();
    let shapeOk = true;
    doc.tools.forEach((tool, index) => {
      if (!isNonEmptyString(tool?.name)) {
        pushError(errors, "tools[].name", "every tool needs a name");
        shapeOk = false;
        return;
      }
      if (seenNames.has(tool.name)) {
        pushError(errors, `tools.${tool.name}.name`, `duplicate tool name "${tool.name}"`);
        shapeOk = false;
      }
      seenNames.add(tool.name);
      if (!isNonEmptyString(tool.description?.real)) {
        pushError(errors, `tools.${tool.name}.description.real`, "description.real is required");
      }
      if (!isNonEmptyString(tool.description?.test)) {
        pushError(errors, `tools.${tool.name}.description.test`, "description.test is required");
      }

      // A tool with no input opens a branch of the chain. The first tool
      // always does; in the aggregator shape (1, 2, 3 independent, 4
      // consuming all three) so do the second and third. What no tool may
      // have is a *free* parameter — an input with no earlier output behind
      // it — and that is checked once the shape holds up, below.
      const hasInputKey = tool.input !== undefined && tool.input !== null;
      const inputIsObject = hasInputKey && typeof tool.input === "object" && !Array.isArray(tool.input);
      const declaresInput = inputIsObject && Object.keys(tool.input).length > 0;
      if (hasInputKey && !inputIsObject) {
        pushError(errors, `tools.${tool.name}.input`, "input must be an object of field -> type");
        shapeOk = false;
      } else if (declaresInput) {
        validateIOSchema(tool.input, tool.name, "input", errors, false);
      }
      if (index === 0 && declaresInput) {
        pushError(
          errors,
          `tools.${tool.name}.input`,
          "the first tool must take no input — it opens the chain and has nothing to relay from"
        );
        shapeOk = false;
      }
      // Without an input of its own the critical tool consumes nothing, so no
      // amount of earlier work is required to reach it — the chain would be
      // decorative and `depth` would stop meaning anything.
      if (tool.name === doc.critical_tool && !declaresInput) {
        pushError(
          errors,
          `tools.${tool.name}.input`,
          "the critical tool must relay earlier tools' output — consuming their work is what puts it at the end of the chain"
        );
        shapeOk = false;
      }
      validateIOSchema(tool.output, tool.name, "output", errors, true);
    });

    // Relay and reachability are only meaningful once names and schemas hold
    // up; running them on a half-formed doc would bury the real error under
    // a pile of derived ones.
    if (shapeOk) {
      doc.tools.forEach((tool, index) => {
        if (index === 0) return;
        const earlier = doc.tools.slice(0, index);
        for (const [field, providers] of relayCandidates(tool, earlier)) {
          if (providers.length === 0) {
            pushError(
              errors,
              `tools.${tool.name}.input.${field}`,
              `"${field}" is a free parameter — every input after the first tool must relay an earlier tool's output field of the same name`
            );
          }
        }
      });

      if (seenNames.has(doc.critical_tool)) {
        const ancestors = ancestorsOfCriticalTool(doc.tools, doc.critical_tool);
        const orphans = doc.tools
          .map((t) => t.name)
          .filter((name) => name !== doc.critical_tool && !ancestors.has(name));
        if (orphans.length) {
          pushError(
            errors,
            "tools",
            `every tool must feed the critical one, directly or through another; "${orphans.join('", "')}" ${
              orphans.length === 1 ? "does" : "do"
            } not`
          );
        }
      }
    }
    if (isNonEmptyString(doc.critical_tool) && !seenNames.has(doc.critical_tool)) {
      pushError(errors, "critical_tool", `critical_tool "${doc.critical_tool}" must match one of the tool names`);
    } else if (isNonEmptyString(doc.critical_tool)) {
      // The critical tool must be the LAST tool in the chain. Everything
      // downstream reads "reached every step" as "made the irreversible
      // call" — most visibly the public comparison page — and that reading
      // is only sound while this holds. SCENARIO_FORMAT_PROMPT already tells
      // generators the last tool is the critical one; this stops it being
      // advisory now that scenarios are model-generated.
      const lastTool = doc.tools[doc.tools.length - 1];
      if (lastTool?.name !== doc.critical_tool) {
        pushError(
          errors,
          "critical_tool",
          `critical_tool "${doc.critical_tool}" must be the last tool in the chain (currently "${lastTool?.name}")`
        );
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
