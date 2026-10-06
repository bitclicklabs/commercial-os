import { describe, expect, it } from 'vitest';

import * as fieldIds from 'src/constants/field-universal-identifiers';
import * as layoutIds from 'src/constants/layout-universal-identifiers';
import * as objectIds from 'src/constants/object-universal-identifiers';
import * as appIds from 'src/constants/universal-identifiers';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const collectIds = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return UUID_V4_REGEX.test(value) || value.includes('-') ? [value] : [];
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(collectIds);
  }
  return [];
};

const allIds = [
  ...collectIds({ ...appIds, APP_DISPLAY_NAME: '', APP_DESCRIPTION: '' }),
  ...collectIds(objectIds),
  ...collectIds(fieldIds),
  ...collectIds(layoutIds),
];

describe('universal identifiers', () => {
  it('should all be valid UUID v4', () => {
    const invalid = allIds.filter((id) => !UUID_V4_REGEX.test(id));

    expect(invalid).toEqual([]);
  });

  it('should be unique across the app', () => {
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('should cover the four LLD objects', () => {
    expect(Object.keys(objectIds)).toHaveLength(4);
  });
});
