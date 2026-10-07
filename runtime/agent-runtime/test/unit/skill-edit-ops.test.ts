import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROSPECTOR_SYSTEM_PROMPT } from '../../src/agents/prospector-prompt.js';
import { applyEditOperations, EditOperationError, parseEditOperations } from '../../src/skills/edit-ops.js';

const BASE = ['# Skill', '', '## A', '- uno', '- dos', '', '## B', '- tres', ''].join('\n');

describe('applyEditOperations', () => {
  it('ADD inserts whole lines after (or before) the anchor line', () => {
    const after = applyEditOperations(BASE, [{ op: 'ADD', anchor: '- uno', text: '- uno bis' }], { maxAddedRatio: 1 });
    expect(after.text).toBe(BASE.replace('- uno\n', '- uno\n- uno bis\n'));
    const before = applyEditOperations(BASE, [{ op: 'ADD', anchor: 'tres', position: 'before', text: '- casi tres' }], { maxAddedRatio: 1 });
    expect(before.text).toContain('- casi tres\n- tres');
    expect(after.applied[0]).toMatchObject({ op: 'ADD', removed: 0, added: '- uno bis\n'.length });
  });

  it('REPLACE swaps the exact fragment; REMOVE drops whole lines with their line break', () => {
    const r = applyEditOperations(BASE, [{ op: 'REPLACE', find: '- dos', text: '- DOS' }, { op: 'REMOVE', find: '- tres' }], { maxRemovedRatio: 1, maxAddedRatio: 1 });
    expect(r.text).toBe(['# Skill', '', '## A', '- uno', '- DOS', '', '## B', ''].join('\n'));
    expect(r.applied.map((a) => a.op)).toEqual(['REPLACE', 'REMOVE']);
  });

  it('MOVE relocates whole lines; REORDER reorders the ## sections', () => {
    const moved = applyEditOperations(BASE, [{ op: 'MOVE', find: '- uno', anchor: '- tres' }], { maxAddedRatio: 1 });
    expect(moved.text).toBe(['# Skill', '', '## A', '- dos', '', '## B', '- tres', '- uno', ''].join('\n'));
    const reordered = applyEditOperations(BASE, [{ op: 'REORDER', order: ['B', 'A'] }], { maxAddedRatio: 1 });
    expect(reordered.text.indexOf('## B')).toBeLessThan(reordered.text.indexOf('## A'));
    expect(reordered.text.startsWith('# Skill\n\n## B')).toBe(true);
    expect(() => applyEditOperations(BASE, [{ op: 'REORDER', order: ['B'] }])).toThrow(/exactamente las secciones/);
  });

  it('rejects anchors that are missing or not unique, and unknown operations', () => {
    expect(() => applyEditOperations(BASE, [{ op: 'REPLACE', find: 'cuatro', text: 'x' }])).toThrow(EditOperationError);
    expect(() => applyEditOperations(BASE, [{ op: 'REPLACE', find: '- ', text: '* ' }])).toThrow(/aparece \d+ veces/);
    expect(() => applyEditOperations(BASE, [])).toThrow(/vacía/);
    expect(() => parseEditOperations([{ op: 'REWRITE', text: 'todo' }])).toThrow(/desconocida/);
  });

  it('refuses a rewrite: too much of the base removed, or too much added', () => {
    const whole = BASE.trimEnd();
    expect(() => applyEditOperations(BASE, [{ op: 'REPLACE', find: whole, text: 'Otra skill entera' }])).toThrow(/reescribir la skill/);
    expect(() => applyEditOperations(BASE, [{ op: 'ADD', anchor: '- tres', text: 'x'.repeat(BASE.length) }])).toThrow(/divide el cambio/);
  });

  it('applies the EXP-001 operations to v1 as a bounded edit that keeps the untrusted-content rule', () => {
    const file = JSON.parse(readFileSync(new URL('../../../../docs/experimentos/EXP-001-prospector-v2.ops.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const ops = parseEditOperations(file);
    expect(ops.map((o) => o.op)).toEqual(['ADD', 'REPLACE', 'REPLACE', 'REPLACE', 'ADD']);
    expect(ops.every((o) => typeof o.why === 'string' && o.why.length > 20)).toBe(true);
    const r = applyEditOperations(PROSPECTOR_SYSTEM_PROMPT, ops);
    expect(r.removedRatio).toBeLessThan(0.35);
    expect(r.addedRatio).toBeLessThan(0.5);
    expect(r.text).toContain('la confianza no pasa de 0,6');
    expect(r.text).toContain('quantity_max no supera 2,5 veces quantity_min');
    // Everything not targeted by an operation is untouched, including the untrusted-content rule at the end.
    expect(r.text.endsWith(PROSPECTOR_SYSTEM_PROMPT.slice(PROSPECTOR_SYSTEM_PROMPT.indexOf('- Los datos del evento y del expositor vienen')))).toBe(true);
    expect(String(file.change_reason).length).toBeLessThanOrEqual(2000);
  });
});
