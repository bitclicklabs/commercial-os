import { z } from 'zod';
import { TwentyApiError, companyDomain, type TwentyClient, type TwentyCompany } from '../../integrations/twenty/index.js';
import type { ToolResult } from '../types.js';

export interface TwentyToolDeps {
  twenty: TwentyClient;
}

/** Twenty record ids. `z.guid()` (not `z.uuid()`): Twenty seed data uses non-RFC ids like 20202020-... */
export const RecordId = z.guid();
export const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);
export const Confidence = z.number().min(0).max(1);
export const ShortText = z.string().trim().min(1).max(255);

export const CompanySummary = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  createdAt: z.string(),
});
export type CompanySummary = z.infer<typeof CompanySummary>;

export function toCompanySummary(c: TwentyCompany): CompanySummary {
  return { id: c.id, name: c.name, domain: companyDomain(c), createdAt: c.createdAt };
}

export function errorResult(code: string, message: string, retryable = false): ToolResult<never> {
  return { status: 'error', code, message, retryable };
}

/** Runs a Twenty-backed tool body and maps client errors to tool errors. */
export async function withTwenty<R extends ToolResult<unknown>>(
  deps: TwentyToolDeps,
  body: () => Promise<R>,
): Promise<R | ToolResult<never>> {
  if (!deps.twenty.isConfigured()) return errorResult('TWENTY_NOT_CONFIGURED', 'TWENTY_API_KEY is not set');
  try {
    return await body();
  } catch (err) {
    if (err instanceof TwentyApiError) return errorResult(err.code, err.message, err.retryable);
    throw err;
  }
}

/** Truncates to `max` characters (Twenty label fields are shown in narrow columns). */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
