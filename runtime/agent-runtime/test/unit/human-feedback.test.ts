import { describe, expect, it } from 'vitest';
import {
  classifyHypothesisChange,
  diffBusinessFields,
  passedOf,
  scoreOf,
  type ClassifyInput,
  type HypothesisProposal,
} from '../../src/evaluations/human-feedback.js';
import { inputMatchesName } from '../../src/evaluations/link-resolver.js';

const proposal: HypothesisProposal = {
  need: '200 lanyards',
  whyNow: 'Feria en marzo',
  quantityMin: 100,
  quantityMax: 200,
  budgetMinEur: 500,
  recommendedProducts: ['SKU-1'],
  timing: 'THIS_QUARTER',
};

const record = (over: Record<string, unknown> = {}) => ({
  id: 'h1',
  status: 'PROPOSED',
  need: '200 lanyards',
  whyNow: 'Feria en marzo',
  quantityMin: 100,
  quantityMax: 200,
  budgetMin: { amountMicros: 500_000_000, currencyCode: 'EUR' },
  budgetMax: { amountMicros: null, currencyCode: 'EUR' },
  recommendedProducts: ['SKU-1'],
  timing: 'THIS_QUARTER',
  ...over,
});

const input = (over: Partial<ClassifyInput>): ClassifyInput => ({
  eventName: 'commercialHypothesis.updated',
  record: record(),
  updatedFields: [],
  lastKnownStatus: null,
  editedWhileProposed: false,
  proposal,
  ...over,
});

describe('D14 score mapping', () => {
  it('maps ACCEPTED/EDITED/DISCARDED to 1.0/0.5/0.0', () => {
    expect([scoreOf('ACCEPTED'), scoreOf('EDITED'), scoreOf('DISCARDED')]).toEqual([1, 0.5, 0]);
    expect([passedOf('ACCEPTED'), passedOf('EDITED'), passedOf('DISCARDED')]).toEqual([true, true, false]);
  });
});

describe('classifyHypothesisChange: transitions', () => {
  it('PROPOSED -> VALIDATED without edits is ACCEPTED (from status assumed)', () => {
    const c = classifyHypothesisChange(input({ record: record({ status: 'VALIDATED' }), updatedFields: ['status'] }));
    expect(c).toMatchObject({ action: 'record', feedback: 'ACCEPTED', fromStatus: 'PROPOSED', toStatus: 'VALIDATED', fromStatusSource: 'assumed', diff: {} });
  });

  it('PROPOSED -> REJECTED is DISCARDED', () => {
    const c = classifyHypothesisChange(input({ record: record({ status: 'REJECTED' }), updatedFields: ['status'], lastKnownStatus: 'PROPOSED' }));
    expect(c).toMatchObject({ action: 'record', feedback: 'DISCARDED', fromStatus: 'PROPOSED', fromStatusSource: 'last_evaluation' });
  });

  it('VALIDATED after editing (diff vs. proposal) is EDITED', () => {
    const c = classifyHypothesisChange(input({ record: record({ status: 'VALIDATED', quantityMax: 300 }), updatedFields: ['status'] }));
    expect(c).toMatchObject({ action: 'record', feedback: 'EDITED', diff: { quantityMax: { before: 200, after: 300 } }, diffBeforeKnown: true });
  });

  it('VALIDATED with edits in the same update is EDITED', () => {
    const c = classifyHypothesisChange(input({ record: record({ status: 'VALIDATED', need: '300 lanyards' }), updatedFields: ['status', 'need'] }));
    expect(c).toMatchObject({ feedback: 'EDITED', diff: { need: { before: '200 lanyards', after: '300 lanyards' } } });
  });

  it('without proposal, a previous EDITED verdict makes the validation EDITED', () => {
    const c = classifyHypothesisChange(
      input({ proposal: null, record: record({ status: 'VALIDATED' }), updatedFields: ['status'], lastKnownStatus: 'PROPOSED', editedWhileProposed: true }),
    );
    expect(c).toMatchObject({ action: 'record', feedback: 'EDITED', diffBeforeKnown: false });
  });

  it('without proposal and no prior edits, validation is ACCEPTED', () => {
    const c = classifyHypothesisChange(input({ proposal: null, record: record({ status: 'VALIDATED' }), updatedFields: ['status'] }));
    expect(c).toMatchObject({ feedback: 'ACCEPTED' });
  });

  it('a stale last status equal to the target is treated as unknown (assumed PROPOSED)', () => {
    const c = classifyHypothesisChange(input({ record: record({ status: 'VALIDATED' }), updatedFields: ['status'], lastKnownStatus: 'VALIDATED' }));
    expect(c).toMatchObject({ feedback: 'ACCEPTED', fromStatus: 'PROPOSED', fromStatusSource: 'assumed' });
  });

  it('ignores system transitions (EXPIRED, back to PROPOSED, from EXPIRED)', () => {
    expect(classifyHypothesisChange(input({ record: record({ status: 'EXPIRED' }), updatedFields: ['status'] })).action).toBe('ignore');
    expect(classifyHypothesisChange(input({ record: record({ status: 'PROPOSED' }), updatedFields: ['status'], lastKnownStatus: 'VALIDATED' })).action).toBe(
      'ignore',
    );
    expect(classifyHypothesisChange(input({ record: record({ status: 'VALIDATED' }), updatedFields: ['status'], lastKnownStatus: 'EXPIRED' })).action).toBe(
      'ignore',
    );
  });

  it('ignores other events and non-business updates', () => {
    expect(classifyHypothesisChange(input({ eventName: 'commercialHypothesis.created' })).action).toBe('ignore');
    expect(classifyHypothesisChange(input({ updatedFields: ['confidence', 'name'] })).action).toBe('ignore');
  });
});

describe('classifyHypothesisChange: EDITED while PROPOSED', () => {
  it('records the diff against the agent proposal (budget in EUR)', () => {
    const c = classifyHypothesisChange(
      input({
        record: record({ need: '250 lanyards impresos', budgetMax: { amountMicros: 900_000_000, currencyCode: 'EUR' } }),
        updatedFields: ['need', 'budgetMax'],
      }),
    );
    expect(c).toMatchObject({
      action: 'record',
      feedback: 'EDITED',
      fromStatus: 'PROPOSED',
      toStatus: 'PROPOSED',
      diff: { need: { before: '200 lanyards', after: '250 lanyards impresos' }, budgetMax: { before: null, after: 900 } },
    });
  });

  it('without proposal lists the updated fields with unknown before', () => {
    const { diff, beforeKnown } = diffBusinessFields(record({ timing: 'LATER' }), null, ['timing', 'confidence']);
    expect(beforeKnown).toBe(false);
    expect(diff).toEqual({ timing: { before: null, after: 'LATER' } });
  });

  it('ignores an edit that restores the original proposal, and edits after validation', () => {
    expect(classifyHypothesisChange(input({ updatedFields: ['need'] })).action).toBe('ignore');
    expect(classifyHypothesisChange(input({ record: record({ status: 'VALIDATED', need: 'x' }), updatedFields: ['need'] })).action).toBe('ignore');
  });

  it('treats empty arrays, empty strings and null money as equal', () => {
    const { diff } = diffBusinessFields(record({ recommendedProducts: [], need: '' }), { ...proposal, recommendedProducts: undefined, need: null }, []);
    expect(diff).toEqual({});
  });
});

describe('inputMatchesName (company+name fallback)', () => {
  it('matches explicit and default names', () => {
    expect(inputMatchesName({ name: 'Mi hipótesis' }, 'Mi hipótesis')).toBe(true);
    expect(inputMatchesName({ need: '200 lanyards' }, 'Acme — 200 lanyards')).toBe(true);
    expect(inputMatchesName({ need: 'x'.repeat(200) }, `Acme — ${'x'.repeat(200)}`.slice(0, 120))).toBe(true);
    expect(inputMatchesName({ need: 'otra cosa' }, 'Acme — 200 lanyards')).toBe(false);
    expect(inputMatchesName(null, 'Acme — 200 lanyards')).toBe(false);
  });
});
