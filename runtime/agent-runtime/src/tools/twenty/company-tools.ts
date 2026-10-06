import { z } from 'zod';
import {
  TWENTY_OBJECTS,
  TwentyApiError,
  companyDomain,
  currencyToEur,
  filterValue,
  links,
  normalizeDomain,
  type TwentyClient,
  type TwentyCompany,
} from '../../integrations/twenty/index.js';
import { defineTool } from '../types.js';
import { CompanySummary, HttpUrl, RecordId, ShortText, toCompanySummary, withTwenty, type TwentyToolDeps } from './shared.js';

const DomainInput = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .transform((value, ctx) => {
    const domain = normalizeDomain(value);
    if (!domain) {
      ctx.addIssue({ code: 'custom', message: `Not a valid domain: ${value}` });
      return z.NEVER;
    }
    return domain;
  });

/**
 * Companies whose normalised `domainName` equals `domain`. Twenty only offers
 * `ilike` on the link URL, so the exact match is done client side (avoids
 * `acme.com` matching `notacme.com`).
 */
export async function findCompaniesByDomain(twenty: TwentyClient, domain: string, signal?: AbortSignal): Promise<TwentyCompany[]> {
  const { records } = await twenty.list<TwentyCompany>(TWENTY_OBJECTS.company, {
    filter: `domainName.primaryLinkUrl[ilike]:${filterValue(`%${domain}%`)}`,
    limit: 50,
    ...(signal ? { signal } : {}),
  });
  return records.filter((c) => companyDomain(c) === domain);
}

// ---------------------------------------------------------------------------
// find_company (READ)
// ---------------------------------------------------------------------------

export const FindCompanyInput = z
  .object({
    domain: DomainInput.optional(),
    name: z.string().trim().min(2).max(255).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .refine((v) => v.domain !== undefined || v.name !== undefined, { message: 'domain or name is required' });

export const FindCompanyOutput = z.object({
  matchedBy: z.enum(['domain', 'name', 'none']),
  companies: z.array(CompanySummary),
});

export function createFindCompanyTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'find_company',
    name: 'Find company',
    version: '1.0.0',
    description:
      'Look up companies in the CRM (Twenty) by exact web domain (preferred, normalised) or by name (case-insensitive contains). Use it to deduplicate before creating a company.',
    inputSchema: FindCompanyInput,
    outputSchema: FindCompanyOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:companies:read'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        if (input.domain) {
          const byDomain = await findCompaniesByDomain(deps.twenty, input.domain, ctx.signal);
          if (byDomain.length > 0 || !input.name) {
            return {
              status: 'ok',
              output: { matchedBy: byDomain.length > 0 ? 'domain' : 'none', companies: byDomain.slice(0, input.limit).map(toCompanySummary) },
            };
          }
        }
        const { records } = await deps.twenty.list<TwentyCompany>(TWENTY_OBJECTS.company, {
          filter: `name[ilike]:${filterValue(`%${input.name ?? ''}%`)}`,
          limit: input.limit,
          signal: ctx.signal,
        });
        return {
          status: 'ok',
          output: { matchedBy: records.length > 0 ? 'name' : 'none', companies: records.map(toCompanySummary) },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// get_company (READ)
// ---------------------------------------------------------------------------

export const GetCompanyInput = z.object({ companyId: RecordId });

const SignalBrief = z.object({
  id: z.string(),
  name: z.string(),
  signalType: z.string(),
  status: z.string(),
  sourceDomain: z.string().nullable(),
  eventDate: z.string().nullable(),
  confidence: z.number().nullable(),
  detectedAt: z.string().nullable(),
});
const ResearchBrief = z.object({
  id: z.string(),
  name: z.string(),
  researchType: z.string().nullable(),
  summary: z.string().nullable(),
  confidence: z.number().nullable(),
  createdAt: z.string(),
});
const HypothesisBrief = z.object({
  id: z.string(),
  name: z.string(),
  need: z.string().nullable(),
  status: z.string(),
  confidence: z.number().nullable(),
  budgetMaxEur: z.number().nullable(),
});

export const GetCompanyOutput = z.object({
  found: z.boolean(),
  company: CompanySummary.extend({
    linkedinUrl: z.string().nullable(),
    signals: z.array(SignalBrief),
    researches: z.array(ResearchBrief),
    hypotheses: z.array(HypothesisBrief),
  }).nullable(),
});

export function createGetCompanyTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'get_company',
    name: 'Get company',
    version: '1.0.0',
    description: 'Fetch a CRM company by id, with its existing commercial signals, research and hypotheses.',
    inputSchema: GetCompanyInput,
    outputSchema: GetCompanyOutput,
    riskLevel: 'READ',
    sideEffects: false,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:companies:read', 'twenty:signals:read', 'twenty:research:read', 'twenty:hypotheses:read'],
    timeoutMs: 15_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const c = await deps.twenty.get<TwentyCompany>(TWENTY_OBJECTS.company, input.companyId, { depth: 1, signal: ctx.signal });
        if (!c) return { status: 'ok', output: { found: false, company: null } };
        return {
          status: 'ok',
          output: {
            found: true,
            company: {
              ...toCompanySummary(c),
              linkedinUrl: c.linkedinLink?.primaryLinkUrl || null,
              signals: (c.commercialSignals ?? []).map((s) => ({
                id: s.id,
                name: s.name,
                signalType: s.signalType,
                status: s.status,
                sourceDomain: s.sourceDomain || null,
                eventDate: s.eventDate ?? null,
                confidence: s.confidence ?? null,
                detectedAt: s.detectedAt ?? null,
              })),
              researches: (c.researches ?? []).map((r) => ({
                id: r.id,
                name: r.name,
                researchType: r.researchType || null,
                summary: r.summary || null,
                confidence: r.confidence ?? null,
                createdAt: r.createdAt,
              })),
              hypotheses: (c.commercialHypotheses ?? []).map((h) => ({
                id: h.id,
                name: h.name,
                need: h.need || null,
                status: h.status,
                confidence: h.confidence ?? null,
                budgetMaxEur: currencyToEur(h.budgetMax),
              })),
            },
          },
        };
      }),
  });
}

// ---------------------------------------------------------------------------
// upsert_company (LOW_WRITE) — idempotent by domain
// ---------------------------------------------------------------------------

export const UpsertCompanyInput = z.object({
  domain: DomainInput,
  name: ShortText,
  linkedinUrl: HttpUrl.optional(),
  city: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().min(1).max(120).optional(),
});

export const UpsertCompanyOutput = z.object({
  created: z.boolean(),
  idempotencyKey: z.string(),
  company: CompanySummary,
});

export function createUpsertCompanyTool(deps: TwentyToolDeps) {
  return defineTool({
    id: 'upsert_company',
    name: 'Upsert company',
    version: '1.0.0',
    description:
      'Create a CRM company identified by its web domain, or return the existing one if a company with that domain already exists. Existing companies are never overwritten.',
    inputSchema: UpsertCompanyInput,
    outputSchema: UpsertCompanyOutput,
    riskLevel: 'LOW_WRITE',
    sideEffects: true,
    approvalPolicy: { mode: 'NONE' },
    permissions: ['twenty:companies:read', 'twenty:companies:write'],
    timeoutMs: 20_000,
    outputTrust: 'trusted',
    enabled: true,
    execute: (input, ctx) =>
      withTwenty(deps, async () => {
        const idempotencyKey = `publi:company:create:domain:${input.domain}`;
        const existing = await findCompaniesByDomain(deps.twenty, input.domain, ctx.signal);
        if (existing[0]) {
          return { status: 'ok', output: { created: false, idempotencyKey, company: toCompanySummary(existing[0]) } };
        }
        const data: Record<string, unknown> = {
          name: input.name,
          domainName: links(`https://${input.domain}`),
        };
        if (input.linkedinUrl) data.linkedinLink = links(input.linkedinUrl);
        if (input.city || input.country) {
          data.address = { ...(input.city ? { addressCity: input.city } : {}), ...(input.country ? { addressCountry: input.country } : {}) };
        }
        try {
          const created = await deps.twenty.create<TwentyCompany>(TWENTY_OBJECTS.company, data, { signal: ctx.signal });
          ctx.logger.info('company created', { companyId: created.id, domain: input.domain });
          return { status: 'ok', output: { created: true, idempotencyKey, company: toCompanySummary(created) } };
        } catch (err) {
          // Lost a race (Twenty enforces a unique domainName): return the winner.
          if (err instanceof TwentyApiError && err.code === 'TWENTY_DUPLICATE') {
            const winner = (await findCompaniesByDomain(deps.twenty, input.domain, ctx.signal))[0];
            if (winner) return { status: 'ok', output: { created: false, idempotencyKey, company: toCompanySummary(winner) } };
          }
          throw err;
        }
      }),
  });
}
