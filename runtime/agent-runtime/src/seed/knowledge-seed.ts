/**
 * Idempotent seed of the first knowledge entries (LLD v0.1 section 6.4). Only knowledge that
 * PubliEXPE already learned AND documented, each with its evidence:
 *
 * - `prospeccion` / `cantidades-y-presupuesto`: EXP-001, pattern F1 (template quantity and
 *   budget ranges; v2 with a per-product breakdown met criterion 2 on the holdout).
 * - `prospeccion` / `suposiciones-por-nombre`: EXP-001, pattern F3 (identity guessed from the
 *   name written as a fact; criterion 3 met in part, 2/12 -> 8/12).
 * - `email` / `presentacion-primer-contacto`: direct user feedback of 2026-10-07 (CHANGELOG,
 *   tanda 6; LLD v0.3 EmailDrafter `company_descriptor`).
 *
 * NOT seeded on purpose: EXP-001's confidence ceiling (OP1): it caused the confidence-semantics
 * regression (non-relevant public bodies with 0.95) and the gate verdict was ITERATE.
 *
 * Natural key: (tenant, domain, topic). An entry that exists with that key in any status is
 * never touched (a human may have superseded or rejected it). Missing: proposed and activated
 * through the service (same rules as the API: activation needs evidence).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledgeEntries, type KnowledgeEvidence, type KnowledgeSource } from '../db/schema.js';
import { activateEntry, proposeEntry } from '../knowledge/service.js';

export interface KnowledgeSeedEntry {
  domain: string;
  topic: string;
  statement: string;
  evidence: KnowledgeEvidence[];
  confidence: number;
  source: KnowledgeSource;
}

const EXP001_DOC = 'docs/experimentos/EXP-001-prospector-v2.md';
const EXP001_EXECUTIONS: KnowledgeEvidence[] = [
  { type: 'execution', ref: 'e67cba89-4252-45bd-bb25-b15ca0268a6c', note: 'Scout de Gastrónoma 2026, primera página (datos de diseño de EXP-001)' },
  { type: 'execution', ref: '44e35e27-b991-467e-988a-6f0c591669cb', note: 'Scout de Gastrónoma con el atajo JSON (datos de diseño de EXP-001)' },
  { type: 'execution', ref: '7eaa0dd4-930b-4ea6-bdd2-c558c597b97a', note: 'Scout de Gastrónoma completo, expositores 1-60 (datos de diseño de EXP-001)' },
];

export const KNOWLEDGE_SEED: readonly KnowledgeSeedEntry[] = [
  {
    domain: 'prospeccion',
    topic: 'cantidades-y-presupuesto',
    statement:
      'Deriva cantidades y presupuesto de un desglose por producto escrito en la necesidad (unidades aproximadas de cada artículo × precio unitario orientativo); nunca uses horquillas genéricas de plantilla.',
    evidence: [
      {
        type: 'experiment',
        ref: 'EXP-001',
        doc: EXP001_DOC,
        note: 'F1: 0/57 necesidades con cantidades y horquillas repetidas (250-800 u / 600-2.200 €) en entidades distintas. Con desglose (v2): 14/14 necesidades con unidades y 0/14 horquillas con máx./mín. > 2,5 en el holdout.',
      },
      ...EXP001_EXECUTIONS,
    ],
    confidence: 0.8,
    source: 'experiment',
  },
  {
    domain: 'prospeccion',
    topic: 'suposiciones-por-nombre',
    statement:
      'Lo que deduces solo del nombre de un expositor es una suposición: escríbelo como tal («por el nombre, parece…»), nunca como un hecho sobre su identidad o actividad.',
    evidence: [
      {
        type: 'experiment',
        ref: 'EXP-001',
        doc: EXP001_DOC,
        note: 'F3: identidades inventadas a partir del nombre (FEGREPPA con dos identidades distintas, GRECARVAL, HOSTELERÍA VALENCIA). Con la regla (v2): suposiciones marcadas 2/12 -> 8/12 en el holdout.',
      },
      ...EXP001_EXECUTIONS,
    ],
    confidence: 0.7,
    source: 'experiment',
  },
  {
    domain: 'email',
    topic: 'presentacion-primer-contacto',
    statement:
      'En el primer contacto, presenta siempre a PubliEXPE como expertos en merchandising para empresas en la misma frase en que la nombras: el destinatario no conoce la marca.',
    evidence: [
      {
        type: 'feedback',
        ref: '2026-10-07',
        doc: 'docs/CHANGELOG.md',
        note: 'Feedback directo del usuario (tanda 6): la primera mención de PubliEXPE lleva siempre el descriptor «expertos en merchandising para empresas».',
      },
      {
        type: 'document',
        ref: 'LLD-0.3 EmailDrafter company_descriptor',
        doc: 'docs/LLD-0.3-estado-real.md',
        note: 'Garantizado también por código (company_descriptor, corrección company_descriptor_added).',
      },
    ],
    confidence: 0.95,
    source: 'human',
  },
];

export interface KnowledgeSeedResult {
  created: Array<{ id: string; domain: string; topic: string }>;
  unchanged: Array<{ id: string; domain: string; topic: string; status: string }>;
}

export async function seedKnowledge(
  db: Db,
  opts: { tenantId: string; createdBy?: string; log?: (msg: string) => void; entries?: readonly KnowledgeSeedEntry[] },
): Promise<KnowledgeSeedResult> {
  const log = opts.log ?? (() => undefined);
  const result: KnowledgeSeedResult = { created: [], unchanged: [] };
  for (const e of opts.entries ?? KNOWLEDGE_SEED) {
    const [existing] = await db
      .select({ id: knowledgeEntries.id, status: knowledgeEntries.status })
      .from(knowledgeEntries)
      .where(and(eq(knowledgeEntries.tenantId, opts.tenantId), eq(knowledgeEntries.domain, e.domain), eq(knowledgeEntries.topic, e.topic)))
      .limit(1);
    if (existing) {
      result.unchanged.push({ id: existing.id, domain: e.domain, topic: e.topic, status: existing.status });
      continue;
    }
    const proposed = await proposeEntry(db, { tenantId: opts.tenantId, ...e, createdBy: opts.createdBy ?? 'seed' });
    const active = await activateEntry(db, { tenantId: opts.tenantId, id: proposed.id, reason: 'seed: conocimiento documentado con evidencia' });
    result.created.push({ id: active.entry.id, domain: e.domain, topic: e.topic });
    log(`knowledge ${e.domain}/${e.topic}: created ACTIVE (${active.entry.id})`);
  }
  return result;
}
