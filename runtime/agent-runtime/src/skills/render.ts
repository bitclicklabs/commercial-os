/**
 * Rendering of a skill version into the trusted text the runtime injects in the system
 * prompt (LLD v0.2 section 5.3, `SkillLoader.render`). `instructions` goes first and
 * verbatim (no trim), so a version holding only `instructions` renders to exactly that
 * text: the skills migrated from the code constants render byte for byte as before.
 * `content_hash` is the sha256 of this rendered text.
 */
import { createHash } from 'node:crypto';

export interface SkillContent {
  instructions: string;
  constraints?: string | null | undefined;
  examples?: unknown[] | null | undefined;
  antiPatterns?: string | null | undefined;
}

export function renderSkill(c: SkillContent): string {
  const parts = [c.instructions];
  if (c.constraints && c.constraints.trim().length > 0) parts.push(`## Restricciones\n${c.constraints.trim()}`);
  if (c.antiPatterns && c.antiPatterns.trim().length > 0) parts.push(`## Antipatrones (no lo hagas)\n${c.antiPatterns.trim()}`);
  if (c.examples && c.examples.length > 0) {
    parts.push(`## Ejemplos\n${c.examples.map((e) => (typeof e === 'string' ? e : JSON.stringify(e, null, 2))).join('\n\n')}`);
  }
  return parts.join('\n\n');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
