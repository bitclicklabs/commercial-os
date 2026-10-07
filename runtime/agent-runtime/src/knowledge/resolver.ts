/**
 * Knowledge injection (LLD v0.1 sections 6.4 and 16: SEMANTIC memory). When a run starts, the
 * runtime reads the ACTIVE knowledge entries of the agent's `configuration.knowledge_domains`
 * (in force now: `valid_from <= now < valid_until`), newest first, and hands the agent a
 * `KnowledgeSet`. The agent appends its block to the system prompt of its decision/drafting
 * calls with `useKnowledge(ctx, system)`:
 *
 *   ## Conocimiento validado de PubliEXPE
 *   - [prospeccion · cantidades-y-presupuesto] statement...
 *
 * Limits: at most 10 entries and 2,000 characters of block (an entry that does not fit is
 * left out and the next, older one is tried). The trace records the ids injected in a
 * MEMORY_READ step. Never throws: with no domains, no entries or a database error the agent
 * runs exactly as before (the step records why).
 */
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AgentStep } from '../agents/agent.js';
import type { Db } from '../db/client.js';
import { knowledgeEntries, type KnowledgeEntry } from '../db/schema.js';
import { sha256 } from '../skills/render.js';

export const KNOWLEDGE_MAX_ENTRIES = 10;
export const KNOWLEDGE_MAX_CHARS = 2_000;
export const KNOWLEDGE_BLOCK_TITLE = '## Conocimiento validado de PubliEXPE';
const KNOWLEDGE_BLOCK_INTRO =
  'Aprendizajes de PubliEXPE respaldados por evidencia (experimentos y feedback). Aplícalos; si alguno contradice las reglas anteriores, mandan las reglas.';

export type KnowledgeEntryRow = Pick<KnowledgeEntry, 'id' | 'domain' | 'topic' | 'statement' | 'confidence' | 'activatedAt' | 'createdAt'>;

export type KnowledgeResolution = 'ok' | 'empty' | 'no_domains' | 'db_error';

export interface KnowledgeLogger {
  warn(obj: object, msg?: string): void;
}

/** `configuration.knowledge_domains`: lower-case domain names, deduplicated. */
export function knowledgeDomains(configuration: Record<string, unknown> | null | undefined): string[] {
  const raw = configuration?.knowledge_domains;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((d): d is string => typeof d === 'string').map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0))];
}

const line = (e: KnowledgeEntryRow) => `- [${e.domain} · ${e.topic}] ${e.statement.replace(/\s+/g, ' ').trim()}`;

/**
 * Selects what fits: entries arrive newest first; up to `maxEntries` and a block of at most
 * `maxChars` characters (title and intro included).
 */
export function selectEntries(
  entries: readonly KnowledgeEntryRow[],
  maxEntries = KNOWLEDGE_MAX_ENTRIES,
  maxChars = KNOWLEDGE_MAX_CHARS,
): { selected: KnowledgeEntryRow[]; omitted: KnowledgeEntryRow[] } {
  const selected: KnowledgeEntryRow[] = [];
  const omitted: KnowledgeEntryRow[] = [];
  let chars = KNOWLEDGE_BLOCK_TITLE.length + 1 + KNOWLEDGE_BLOCK_INTRO.length;
  for (const e of entries) {
    const len = 1 + line(e).length;
    if (selected.length >= maxEntries || chars + len > maxChars) {
      omitted.push(e);
      continue;
    }
    selected.push(e);
    chars += len;
  }
  return { selected, omitted };
}

export function renderKnowledgeBlock(entries: readonly KnowledgeEntryRow[]): string {
  if (entries.length === 0) return '';
  return [KNOWLEDGE_BLOCK_TITLE, KNOWLEDGE_BLOCK_INTRO, ...entries.map(line)].join('\n');
}

/** Knowledge resolved for one execution. Agents read it through `useKnowledge`. */
export class KnowledgeSet {
  readonly block: string;
  private uses = 0;

  constructor(
    readonly domains: readonly string[],
    readonly entries: readonly KnowledgeEntryRow[],
    readonly omitted: readonly KnowledgeEntryRow[] = [],
    readonly resolution: KnowledgeResolution = entries.length > 0 ? 'ok' : 'empty',
    readonly error: string | null = null,
  ) {
    this.block = renderKnowledgeBlock(entries);
  }

  static empty(domains: readonly string[] = [], resolution: KnowledgeResolution = 'no_domains', error: string | null = null): KnowledgeSet {
    return new KnowledgeSet(domains, [], [], resolution, error);
  }

  /** `system` + the knowledge block (unchanged when there is nothing to inject). */
  apply(system: string): string {
    if (!this.block) return system;
    this.uses += 1;
    return `${system.replace(/\s+$/, '')}\n\n${this.block}`;
  }

  /** Model calls whose system prompt carried the block. */
  get injections(): number {
    return this.uses;
  }

  /**
   * MEMORY_READ step for the trace (LLD 17.1 `memory_reads[]`), or null when the agent version
   * has no `knowledge_domains` (nothing was read: the trace stays as before).
   */
  traceStep(at: Date = new Date()): AgentStep | null {
    if (this.domains.length === 0) return null;
    return {
      type: 'MEMORY_READ',
      timestamp: at,
      input: { memory: 'semantic', store: 'knowledge_entries', domains: [...this.domains], status: 'ACTIVE' },
      output: {
        resolution: this.resolution,
        knowledge_entry_ids: this.entries.map((e) => e.id),
        entries: this.entries.map((e) => ({ id: e.id, domain: e.domain, topic: e.topic, confidence: e.confidence })),
        omitted_ids: this.omitted.map((e) => e.id),
        block_chars: this.block.length,
        ...(this.block ? { block_hash: sha256(this.block) } : {}),
        injected: this.uses > 0,
        injections: this.uses,
      },
      ...(this.error ? { error: { code: 'KNOWLEDGE_DB_ERROR', message: this.error } } : {}),
      latencyMs: 0,
    };
  }
}

/** Appends the validated knowledge to `system` (no-op without a resolved set). */
export function useKnowledge(ctx: { knowledge?: KnowledgeSet | undefined }, system: string): string {
  return ctx.knowledge ? ctx.knowledge.apply(system) : system;
}

/** Read side (the database; an in-memory one in unit tests). Newest first. */
export interface KnowledgeStore {
  active(tenantId: string, domains: readonly string[], now: Date, limit: number): Promise<KnowledgeEntryRow[]>;
}

export function dbKnowledgeStore(db: Db): KnowledgeStore {
  return {
    async active(tenantId, domains, now, limit) {
      return db
        .select({
          id: knowledgeEntries.id,
          domain: knowledgeEntries.domain,
          topic: knowledgeEntries.topic,
          statement: knowledgeEntries.statement,
          confidence: knowledgeEntries.confidence,
          activatedAt: knowledgeEntries.activatedAt,
          createdAt: knowledgeEntries.createdAt,
        })
        .from(knowledgeEntries)
        .where(
          and(
            eq(knowledgeEntries.tenantId, tenantId),
            eq(knowledgeEntries.status, 'ACTIVE'),
            inArray(knowledgeEntries.domain, [...domains]),
            or(isNull(knowledgeEntries.validFrom), lte(knowledgeEntries.validFrom, now)),
            or(isNull(knowledgeEntries.validUntil), gt(knowledgeEntries.validUntil, now)),
          ),
        )
        .orderBy(desc(sql`coalesce(${knowledgeEntries.activatedAt}, ${knowledgeEntries.createdAt})`), desc(knowledgeEntries.createdAt))
        .limit(limit);
    },
  };
}

/** Resolves the knowledge of an agent version. Never throws. */
export async function resolveKnowledge(
  source: Db | KnowledgeStore,
  tenantId: string,
  configuration: Record<string, unknown> | null | undefined,
  logger?: KnowledgeLogger,
  now: Date = new Date(),
): Promise<KnowledgeSet> {
  const domains = knowledgeDomains(configuration);
  if (domains.length === 0) return KnowledgeSet.empty();
  const store: KnowledgeStore = 'active' in source && typeof source.active === 'function' ? source : dbKnowledgeStore(source as Db);
  try {
    // Read a few more than the cap: entries left out for size are reported in the trace.
    const rows = await store.active(tenantId, domains, now, KNOWLEDGE_MAX_ENTRIES * 2);
    const { selected, omitted } = selectEntries(rows);
    return new KnowledgeSet(domains, selected, omitted);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger?.warn({ tenantId, domains, err: message }, 'knowledge resolution failed (database error); the agent runs without it');
    return KnowledgeSet.empty(domains, 'db_error', message.slice(0, 500));
  }
}
