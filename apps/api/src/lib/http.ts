import type { ZodType } from 'zod';

/** Parse & validate input with zod; throws ZodError (mapped to 400 by the error handler). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data ?? {});
}

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
