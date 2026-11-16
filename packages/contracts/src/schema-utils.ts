import { z } from 'zod';

/**
 * Convert a Zod schema to Draft-07 JSON Schema without top-level `$schema`
 * so downstream CLIs (such as `agy --json-schema`) accept it cleanly.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return rest;
}
