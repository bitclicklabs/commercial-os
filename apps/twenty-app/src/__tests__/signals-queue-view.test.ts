import { describe, expect, it } from 'vitest';

import { COMMERCIAL_SIGNAL_FIELD_IDS } from 'src/constants/field-universal-identifiers';
import { SIGNALS_QUEUE_VIEW_IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';
import signalObject from 'src/objects/commercial-signal.object';
import signalsQueue, { SIGNAL_QUEUE_STATUSES } from 'src/views/signals-queue.view';

describe('Señales · Cola view (tanda 19)', () => {
  it('builds a valid kanban of commercial signals grouped by status', () => {
    expect(signalsQueue.errors).toEqual([]);
    expect(signalsQueue.success).toBe(true);
    const view = signalsQueue.config;
    expect(view.universalIdentifier).toBe(SIGNALS_QUEUE_VIEW_IDS.view);
    expect(view.type).toBe('KANBAN');
    expect(view.objectUniversalIdentifier).toBe(COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER);
    expect(view.mainGroupByFieldMetadataUniversalIdentifier).toBe(COMMERCIAL_SIGNAL_FIELD_IDS.status);
  });

  it('has one group per status option of the Signal object, in order', () => {
    const status = signalObject.config.fields.find((f) => f.name === 'status') as { options: { value: string }[] };
    expect(status.options.map((o) => o.value)).toEqual([...SIGNAL_QUEUE_STATUSES]);
    expect(signalsQueue.config.groups?.map((g) => g.fieldValue)).toEqual([...SIGNAL_QUEUE_STATUSES]);
  });

  it('only shows fields of the Signal object', () => {
    const fieldIds = new Set<string>(Object.values(COMMERCIAL_SIGNAL_FIELD_IDS));
    for (const f of signalsQueue.config.fields ?? []) expect(fieldIds.has(f.fieldMetadataUniversalIdentifier)).toBe(true);
  });
});
