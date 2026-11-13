/**
 * A small validator for the JSON Schema subset used by tool definitions.
 * Tool arguments come from the model and are never trusted.
 */

export interface SchemaNode {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: Array<string | number | boolean>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface ValidationResult {
  ok: boolean;
  /** The arguments with unknown properties removed. */
  value?: unknown;
  errors: string[];
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function check(schema: SchemaNode, value: unknown, where: string, errors: string[]): unknown {
  const at = where || 'arguments';
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${at} must be a string, got ${typeName(value)}.`);
        return value;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} must not be empty.`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} is too long (max ${schema.maxLength} characters).`);
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${at} must be a number, got ${typeName(value)}.`);
        return value;
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${at} must be a whole number.`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be at least ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be at most ${schema.maximum}.`);
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${at} must be true or false, got ${typeName(value)}.`);
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${at} must be a list, got ${typeName(value)}.`);
        return value;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}.`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at} may have at most ${schema.maxItems} items.`);
      if (schema.items) return value.map((item, i) => check(schema.items as SchemaNode, item, `${at}[${i}]`, errors));
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${at} must be an object, got ${typeName(value)}.`);
        return value;
      }
      const input = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        if (input[key] === undefined || input[key] === null) errors.push(`${where ? `${where}.` : ''}${key} is required.`);
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (input[key] === undefined || input[key] === null) continue;
        output[key] = check(child, input[key], where ? `${where}.${key}` : key, errors);
      }
      return output;
    }
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    errors.push(`${at} must be one of: ${schema.enum.join(', ')}.`);
  }
  return value;
}

export function validateArguments(schema: SchemaNode, value: unknown): ValidationResult {
  const errors: string[] = [];
  const cleaned = check(schema, value, '', errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: cleaned, errors };
}
