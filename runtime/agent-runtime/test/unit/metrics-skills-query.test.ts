import { describe, expect, it } from 'vitest';
import { MetricsSkillsQuery } from '../../src/api/routes/metrics.js';

describe('MetricsSkillsQuery (GET /metrics/skills)', () => {
  it('defaults: no skill filter, archived agents hidden', () => {
    const q = MetricsSkillsQuery.parse({});
    expect(q).toEqual({ include_archived: false });
  });

  it('accepts a kebab-case skill name and the window', () => {
    const q = MetricsSkillsQuery.parse({
      skill: 'prospector-event-exhibitors',
      since: '2026-10-01T00:00:00+02:00',
      until: '2026-10-07T00:00:00+02:00',
      include_archived: 'true',
    });
    expect(q.skill).toBe('prospector-event-exhibitors');
    expect(q.include_archived).toBe(true);
  });

  it('rejects non-kebab-case skill names (SQL goes through a bind, this is just the contract)', () => {
    for (const skill of ['Not_Kebab', 'UPPER', 'a--b', '-leading', 'trailing-', 'con espacios']) {
      expect(MetricsSkillsQuery.safeParse({ skill }).success, skill).toBe(false);
    }
  });

  it('rejects since >= until and dates without offset', () => {
    expect(MetricsSkillsQuery.safeParse({ since: '2026-10-07T00:00:00+02:00', until: '2026-10-01T00:00:00+02:00' }).success).toBe(false);
    expect(MetricsSkillsQuery.safeParse({ since: '2026-10-01' }).success).toBe(false);
  });
});
