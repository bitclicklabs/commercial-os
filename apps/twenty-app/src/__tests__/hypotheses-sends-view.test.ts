import { describe, expect, it } from 'vitest';

import { COMMERCIAL_HYPOTHESIS_FIELD_IDS } from 'src/constants/field-universal-identifiers';
import { HYPOTHESES_SENDS_VIEW_IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';
import hypothesisObject from 'src/objects/commercial-hypothesis.object';
import hypothesesSends, { HYPOTHESIS_EMAIL_STATUSES, HYPOTHESIS_SYSTEM_FIELD_IDS, NO_VALUE_GROUP } from 'src/views/hypotheses-sends.view';

describe('Hipótesis · Envíos view (tanda 21)', () => {
  it('builds a valid kanban of hypotheses grouped by emailStatus', () => {
    expect(hypothesesSends.errors).toEqual([]);
    expect(hypothesesSends.success).toBe(true);
    const view = hypothesesSends.config;
    expect(view.universalIdentifier).toBe(HYPOTHESES_SENDS_VIEW_IDS.view);
    expect(view.name).toBe('Hipótesis · Envíos');
    expect(view.type).toBe('KANBAN');
    expect(view.objectUniversalIdentifier).toBe(COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER);
    expect(view.mainGroupByFieldMetadataUniversalIdentifier).toBe(COMMERCIAL_HYPOTHESIS_FIELD_IDS.emailStatus);
  });

  it('has the no-value column plus one group per emailStatus option of the object, in order', () => {
    const emailStatus = hypothesisObject.config.fields.find((f) => f.name === 'emailStatus') as { options: { value: string }[] };
    expect(emailStatus.options.map((o) => o.value)).toEqual([...HYPOTHESIS_EMAIL_STATUSES]);
    expect(hypothesesSends.config.groups?.map((g) => g.fieldValue)).toEqual([NO_VALUE_GROUP, ...HYPOTHESIS_EMAIL_STATUSES]);
  });

  it('shows fields of the Hypothesis object (custom fields and the derived createdAt / updatedAt)', () => {
    const fieldIds = new Set<string>([...Object.values(COMMERCIAL_HYPOTHESIS_FIELD_IDS), ...Object.values(HYPOTHESIS_SYSTEM_FIELD_IDS)]);
    const shown = hypothesesSends.config.fields ?? [];
    for (const f of shown) expect(fieldIds.has(f.fieldMetadataUniversalIdentifier)).toBe(true);
    expect(shown.map((f) => f.fieldMetadataUniversalIdentifier)).toEqual(
      expect.arrayContaining([COMMERCIAL_HYPOTHESIS_FIELD_IDS.company, COMMERCIAL_HYPOTHESIS_FIELD_IDS.emailTo, HYPOTHESIS_SYSTEM_FIELD_IDS.updatedAt]),
    );
    // Deterministic: the same ids on every build (the sync must not see changes).
    expect(new Set(Object.values(HYPOTHESIS_SYSTEM_FIELD_IDS)).size).toBe(2);
    for (const id of Object.values(HYPOTHESIS_SYSTEM_FIELD_IDS)) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
