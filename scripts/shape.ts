// A response's structure without its values: which fields exist and what types
// they hold. scripts/record-shapes.ts saves one per source from a live response,
// and the contract tests check the hand-written fixtures against them.

export interface Shape {
  /** Every JSON type seen here, e.g. "string|null". "undefined" means some objects lacked the field. */
  type: string;
  fields?: Record<string, Shape>;
  items?: Shape;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function addType(shape: Shape, type: string): void {
  const types = new Set(shape.type.split("|").filter(Boolean));
  types.add(type);
  shape.type = [...types].sort().join("|");
}

function merge(into: Shape, value: unknown): void {
  addType(into, typeName(value));
  if (Array.isArray(value)) {
    into.items ??= { type: "" };
    for (const item of value) merge(into.items, item);
  } else if (value !== null && typeof value === "object") {
    const seen = into.fields !== undefined;
    into.fields ??= {};
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (!into.fields[key]) into.fields[key] = { type: seen ? "undefined" : "" };
      merge(into.fields[key], child);
    }
    for (const [key, field] of Object.entries(into.fields)) if (!(key in record)) addType(field, "undefined");
  }
}

/** The merged shape of one or more sample values. */
export function shapeOf(...samples: unknown[]): Shape {
  const shape: Shape = { type: "" };
  for (const sample of samples) merge(shape, sample);
  return shape;
}

/** Problems with `value` against `shape`: unknown fields or types the live API never sent. */
export function conformance(value: unknown, shape: Shape, path = "$"): string[] {
  const type = typeName(value);
  const allowed = shape.type.split("|");
  if (!allowed.includes(type)) return [`${path}: ${type}, but the API sends ${shape.type}`];
  const problems: string[] = [];
  if (Array.isArray(value) && shape.items) {
    for (const [i, item] of value.entries())
      problems.push(...conformance(item, shape.items, `${path}[${i}]`));
  } else if (type === "object" && shape.fields) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const field = shape.fields[key];
      if (!field) problems.push(`${path}.${key}: not in the live response`);
      else problems.push(...conformance(child, field, `${path}.${key}`));
    }
  }
  return problems;
}
