/**
 * pnpm skill:candidate <skill> --ops <operaciones.json> [--post] [--created-by <quién>]
 *                      [--api http://127.0.0.1:4020] [--tenant publiexpe]
 *
 * Builds a candidate version of a skill as the base version plus a bounded list of
 * operations (ADD, REMOVE, REPLACE, MOVE, REORDER; LLD v0.1 section 6.3) and prints the
 * resulting diff and the share of text touched. Without `--post` nothing is written.
 *
 * With `--post` it creates the candidate through the API as a DRAFT version
 * (POST /skills/:id/versions, `copy_from` = base version). It never activates it: the
 * activation is a human decision (POST /skills/:id/versions/:v/activate).
 *
 * Operations file:
 * {
 *   "base_version": 1,
 *   "change_reason": "por qué (máx. 2.000 caracteres)",
 *   "experiment": "EXP-001",
 *   "design_data": { ... qué trazas justificaron el cambio ... },
 *   "operations": [ { "op": "REPLACE", "find": "...", "text": "...", "why": "patrón F1" } ]
 * }
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyEditOperations, parseEditOperations } from '../src/skills/edit-ops.js';
import { renderSkill, sha256 } from '../src/skills/render.js';

interface ApiVersion {
  id: string;
  version: number;
  status: string;
  instructions: string;
  constraints: string | null;
  examples: unknown[] | null;
  anti_patterns: string | null;
  content_hash: string;
}

function lineDiff(a: string, b: string): string {
  const x = a.split('\n');
  const y = b.split('\n');
  // LCS table (skills are a few hundred lines at most).
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const all: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      all.push(`  ${x[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) all.push(`- ${x[i++]}`);
    else all.push(`+ ${y[j++]}`);
  }
  while (i < x.length) all.push(`- ${x[i++]}`);
  while (j < y.length) all.push(`+ ${y[j++]}`);
  // Changed lines with one line of context around them.
  const changed = (l: string | undefined) => l !== undefined && !l.startsWith('  ');
  const keep = all.map((l, k) => changed(l) || changed(all[k - 1]) || changed(all[k + 1]));
  const out: string[] = [];
  keep.forEach((k, n) => {
    if (k) out.push(all[n]!);
    else if (keep[n - 1]) out.push('  …');
  });
  return out.join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ops: { type: 'string' },
      post: { type: 'boolean', default: false },
      'created-by': { type: 'string', default: 'skill-cycle (manual)' },
      api: { type: 'string', default: process.env.RUNTIME_API_URL ?? 'http://127.0.0.1:4020' },
      tenant: { type: 'string', default: process.env.DEFAULT_TENANT_ID ?? 'publiexpe' },
    },
  });
  const skill = positionals[0];
  if (!skill || !values.ops) {
    console.error('uso: pnpm skill:candidate <skill> --ops <operaciones.json> [--post]');
    process.exit(2);
  }
  const file = JSON.parse(readFileSync(resolve(values.ops), 'utf8')) as Record<string, unknown>;
  const operations = parseEditOperations(file);
  const baseVersion = Number(file.base_version);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) throw new Error('el fichero necesita "base_version" (entero)');
  const changeReason = typeof file.change_reason === 'string' ? file.change_reason : '';
  if (changeReason.length === 0 || changeReason.length > 2000) throw new Error('"change_reason" es obligatorio (1-2.000 caracteres)');

  const api = values.api!.replace(/\/$/, '');
  const headers = { 'x-tenant-id': values.tenant!, 'content-type': 'application/json' };
  const res = await fetch(`${api}/skills/${encodeURIComponent(skill)}`, { headers });
  if (!res.ok) throw new Error(`GET /skills/${skill} respondió ${res.status}`);
  const body = (await res.json()) as { versions: ApiVersion[] };
  const base = body.versions.find((v) => v.version === baseVersion);
  if (!base) throw new Error(`no existe la versión base ${baseVersion}`);
  if (base.constraints || base.anti_patterns || (base.examples && base.examples.length > 0)) {
    throw new Error('la versión base tiene constraints/anti_patterns/examples: este script solo edita "instructions"; amplíalo antes de usarlo');
  }

  const edited = applyEditOperations(base.instructions, operations);
  const candidateHash = sha256(renderSkill({ instructions: edited.text }));
  console.log(`# ${skill}: candidata desde v${base.version} (${base.status})`);
  console.log(`operaciones: ${edited.applied.map((a) => a.op).join(', ')} · texto base borrado o sustituido: ${(edited.removedRatio * 100).toFixed(1)} % · texto añadido: ${(edited.addedRatio * 100).toFixed(1)} % · ${base.instructions.length} → ${edited.text.length} caracteres`);
  console.log(`content_hash candidata: ${candidateHash}`);
  const duplicate = body.versions.find((v) => v.content_hash === candidateHash);
  if (duplicate) throw new Error(`la candidata es idéntica a la v${duplicate.version} existente; no se crea otra versión`);
  console.log('\n```diff');
  console.log(lineDiff(base.instructions, edited.text));
  console.log('```');

  if (!values.post) {
    console.log('\n(simulación: añade --post para crear la versión DRAFT)');
    return;
  }
  const metadata = {
    experiment: file.experiment ?? null,
    base_version: base.version,
    removed_ratio: edited.removedRatio,
    added_ratio: edited.addedRatio,
    operations: operations.map((op, i) => ({ ...op, removed_chars: edited.applied[i]!.removed, added_chars: edited.applied[i]!.added })),
    ...(file.design_data ? { design_data: file.design_data } : {}),
    ...(file.validation_data ? { validation_data: file.validation_data } : {}),
  };
  const post = await fetch(`${api}/skills/${encodeURIComponent(skill)}/versions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ copy_from: base.version, instructions: edited.text, change_reason: changeReason, metadata, created_by: values['created-by'] }),
  });
  const created = (await post.json()) as { version?: { version: number; status: string; id: string; content_hash: string }; warnings?: string[]; error?: unknown };
  if (post.status !== 201 || !created.version) throw new Error(`POST /skills/${skill}/versions respondió ${post.status}: ${JSON.stringify(created).slice(0, 500)}`);
  console.log(`\ncreada v${created.version.version} (${created.version.status}) id=${created.version.id} hash=${created.version.content_hash}`);
  if (created.version.content_hash !== candidateHash) throw new Error('el content_hash devuelto no coincide con el de la candidata');
  for (const w of created.warnings ?? []) console.log(`aviso: ${w}`);
  console.log(`No se ha activado. Siguiente paso: pnpm experiment:run --subject skill:${skill} --candidate ${created.version.version}`);
  console.log(`Activarla es decisión humana y pasa por el Release Gate: POST /skills/${skill}/versions/${created.version.version}/activate (exige un experimento PASS o PASS_FORM, o force + reason).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
