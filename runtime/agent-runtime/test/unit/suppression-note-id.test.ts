import { describe, expect, it } from 'vitest';
import { SUPPRESSION_NOTE_ID, suppressionNoteId } from '../../src/inbound/suppression-list.js';

describe('id de la nota de supresión', () => {
  it('SUPPRESSION_NOTE_ID manda sobre el id sembrado en la configuración', () => {
    expect(suppressionNoteId('id-sembrado', { SUPPRESSION_NOTE_ID: ' id-nuevo ' })).toBe('id-nuevo');
  });

  it('sin variable, usa el de la configuración y, si falta, la constante', () => {
    expect(suppressionNoteId('id-sembrado', {})).toBe('id-sembrado');
    expect(suppressionNoteId(undefined, { SUPPRESSION_NOTE_ID: '  ' })).toBe(SUPPRESSION_NOTE_ID);
  });
});
