/**
 * 宿主工具适配层看到 dreammate_invoke.params 是无属性 object 时，会把数字和布尔值收成字符串。
 * 目标方法的 JSON Schema 仍知道类型。这里只在契约明确要求时还原，不猜测未声明的字段。
 */

type ScalarKind = 'number' | 'integer' | 'boolean';

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_INTEGER = /^-?(?:0|[1-9]\d*)$/;

function isSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNullSchema(schema: unknown): boolean {
  if (!isSchema(schema)) return false;
  const type = schema.type;
  return type === 'null' || (Array.isArray(type) && type.length === 1 && type[0] === 'null');
}

function kindFromType(type: unknown): ScalarKind | undefined {
  const types = (Array.isArray(type) ? type : type === undefined ? [] : [type]).filter(item => item !== 'null');
  if (types.length !== 1) return;
  const only = types[0];
  return only === 'number' || only === 'integer' || only === 'boolean' ? only : undefined;
}

function scalarKind(schema: unknown): ScalarKind | undefined {
  if (!isSchema(schema)) return;
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (union) {
    const kinds = new Set<ScalarKind>();
    let other = false;
    for (const branch of union) {
      if (isNullSchema(branch)) continue;
      const kind = scalarKind(branch);
      if (kind) kinds.add(kind);
      else other = true;
    }
    if (other || kinds.size !== 1) return;
    return [...kinds][0];
  }
  return kindFromType(schema.type);
}

function coerce(value: unknown, kind: ScalarKind): unknown {
  if (typeof value !== 'string') return value;
  if (kind === 'boolean') return value === 'true' ? true : value === 'false' ? false : value;
  if (kind === 'integer') {
    if (!JSON_INTEGER.test(value)) return value;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  if (!JSON_NUMBER.test(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function restore(value: unknown, schema: unknown): unknown {
  const kind = scalarKind(schema);
  if (kind) return coerce(value, kind);
  if (!isSchema(schema)) return value;
  const type = schema.type;
  const types = Array.isArray(type) ? type : typeof type === 'string' ? [type] : [];
  const properties = isSchema(schema.properties) ? schema.properties : undefined;
  const extra = isSchema(schema.additionalProperties) ? schema.additionalProperties : undefined;
  if ((types.includes('object') || properties) && isSchema(value)) {
    if (!properties && !extra) return value;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties && Object.hasOwn(properties, key) ? properties[key] : extra;
      const next = childSchema === undefined ? child : restore(child, childSchema);
      if (next !== child) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  if ((types.includes('array') || schema.items !== undefined) && Array.isArray(value) && isSchema(schema.items)) {
    let changed = false;
    const out = value.map(item => {
      const next = restore(item, schema.items);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  return value;
}

/** 参数里是否有可能被宿主收成字符串的数字或布尔值。没有就不必读方法 Schema。 */
export function needsTypeRestore(value: unknown): boolean {
  if (typeof value === 'string') return value === 'true' || value === 'false' || JSON_NUMBER.test(value);
  if (Array.isArray(value)) return value.some(needsTypeRestore);
  if (isSchema(value)) return Object.values(value).some(needsTypeRestore);
  return false;
}

/** 按方法入参 Schema 还原被收成字符串的 number、integer、boolean。其余值原样返回。 */
export function restoreTypedParams<T>(value: T, schema: unknown): T {
  return restore(value, schema) as T;
}
