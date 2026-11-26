import { describe, expect, it } from 'vitest';
import { twentyPublicBaseUrl, twentyRecordUrl } from '../../src/crm/reply-task.js';

describe('enlaces a registros de Twenty en Tasks y notas', () => {
  it('usan TWENTY_PUBLIC_URL, no el host interno de Docker', () => {
    const env = { TWENTY_PUBLIC_URL: 'http://localhost:3020/' };
    expect(twentyRecordUrl('http://pxos-twenty:3000', 'opportunity', 'abc', env)).toBe('http://localhost:3020/object/opportunity/abc');
    expect(twentyRecordUrl('http://pxos-twenty:3000', 'commercialHypothesis', 'h 1', env)).toBe('http://localhost:3020/object/commercialHypothesis/h%201');
  });

  it('sin TWENTY_PUBLIC_URL conservan la base de la API (runtime fuera de Docker)', () => {
    expect(twentyPublicBaseUrl('http://localhost:3020/', {})).toBe('http://localhost:3020');
    expect(twentyRecordUrl('http://localhost:3020', 'note', 'n1', { TWENTY_PUBLIC_URL: '  ' })).toBe('http://localhost:3020/object/note/n1');
  });
});
