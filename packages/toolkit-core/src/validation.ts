import type { JsonObject, JsonValue } from '@mido-agent/protocol-core';

export function readRequiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

export function readOptionalString(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }

  return value;
}

export function readOptionalNumber(value: JsonValue | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
}

export function readOptionalBoolean(value: JsonValue | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }

  return value;
}

export function readOptionalStringArray(value: JsonValue | undefined, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }

  return value;
}

export function readOptionalJsonObject(value: JsonValue | undefined, name: string): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new Error(`${name} must be an object`);
  }

  return value;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toJsonValue(value: unknown): JsonValue {
  return stripUndefined(value) as JsonValue;
}

function stripUndefined(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(item => stripUndefined(item));
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        output[key] = stripUndefined(item);
      }
    }
    return output;
  }

  return value;
}
