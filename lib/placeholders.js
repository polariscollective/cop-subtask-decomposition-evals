// Shared between app/page.js (manual UI) and the batch step runner: resolve
// "<step_N.field>" placeholders in a plan step's arguments against prior
// steps' (stubbed) outputs.

// "<step_N.field>" - a scalar output field from a prior step.
// "<step_N.arrayField[].subField>" - list of subField pulled across an
// array-valued prior output (e.g. a list of IDs from a list of objects).
function resolveScalar(val, priorOutputs) {
  if (typeof val !== "string") return val;
  let m = val.match(/^<step_(\d+)\.(\w+)>$/);
  if (m) {
    const stepOut = priorOutputs[parseInt(m[1], 10)];
    return stepOut ? stepOut[m[2]] : val;
  }
  m = val.match(/^<step_(\d+)\.(\w+)\[\]\.(\w+)>$/);
  if (m) {
    const stepOut = priorOutputs[parseInt(m[1], 10)];
    const arr = stepOut ? stepOut[m[2]] : null;
    if (Array.isArray(arr)) return arr.map((item) => (item ? item[m[3]] : undefined));
    return val;
  }
  return val;
}

// Array-typed arguments are resolved element-by-element, since a
// placeholder there could itself expand into a list (the "[].subField"
// form above).
export function resolveArgs(rawArgs, priorOutputs) {
  const resolved = {};
  for (const [key, val] of Object.entries(rawArgs)) {
    if (Array.isArray(val)) {
      resolved[key] = val.flatMap((item) => {
        const r = resolveScalar(item, priorOutputs);
        return Array.isArray(r) ? r : [r];
      });
    } else {
      resolved[key] = resolveScalar(val, priorOutputs);
    }
  }
  return resolved;
}
