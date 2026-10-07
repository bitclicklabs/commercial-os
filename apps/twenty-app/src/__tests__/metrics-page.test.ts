import { describe, expect, it } from 'vitest';

import {
  AGENT_OS_DAILY_METRIC_FIELD_IDS,
  AGENT_RUN_SUMMARY_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import {
  LATEST_AGENT_RUNS_VIEW_IDS,
  METRICS_PAGE_IDS,
} from 'src/constants/layout-universal-identifiers';
import {
  AGENT_OS_DAILY_METRIC_OBJECT_UNIVERSAL_IDENTIFIER,
  AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/object-universal-identifiers';
import metricsNavigationItem from 'src/navigation-menu-items/metrics.navigation-menu-item';
import runtimeDashboardItem from 'src/navigation-menu-items/runtime-dashboard.navigation-menu-item';
import dailyMetricObject from 'src/objects/agent-os-daily-metric.object';
import metricsPage, { lastDaysFilter } from 'src/page-layouts/agent-os-metrics.page-layout';
import latestRunsView from 'src/views/latest-agent-runs.view';

type Widget = {
  universalIdentifier: string;
  title: string;
  type: string;
  objectUniversalIdentifier?: string;
  position: { row: number; column: number; rowSpan: number; columnSpan: number };
  configuration: Record<string, unknown> & {
    configurationType: string;
    filter?: { recordFilters: { fieldMetadataUniversalIdentifier: string; recordFilterGroupId: string }[]; recordFilterGroups: { id: string }[] };
  };
};

const page = metricsPage.config as unknown as { type: string; tabs: { layoutMode: string; widgets: Widget[] }[] };
const widgets = page.tabs[0]!.widgets;
const dailyFieldIds = new Set<string>(Object.values(AGENT_OS_DAILY_METRIC_FIELD_IDS));

describe('Agent OS metrics page', () => {
  it('builds valid SDK entities', () => {
    for (const entity of [metricsPage, metricsNavigationItem, runtimeDashboardItem, dailyMetricObject, latestRunsView]) {
      expect(entity.errors).toEqual([]);
      expect(entity.success).toBe(true);
    }
  });

  it('is a standalone page with one grid tab (the only type a PAGE_LAYOUT menu item may open)', () => {
    expect(page.type).toBe('STANDALONE_PAGE');
    expect(page.tabs).toHaveLength(1);
    expect(page.tabs[0]!.layoutMode).toBe('GRID');
    expect(metricsNavigationItem.config.pageLayoutUniversalIdentifier).toBe(METRICS_PAGE_IDS.pageLayout);
  });

  it('declares every widget id from the constants exactly once', () => {
    const declared = Object.entries(METRICS_PAGE_IDS)
      .filter(([key]) => key.startsWith('widget'))
      .map(([, id]) => id)
      .sort();
    expect(widgets.map((w) => w.universalIdentifier).sort()).toEqual(declared);
  });

  it('keeps the widgets inside the 12-column grid without overlaps', () => {
    const cells = new Set<string>();
    for (const w of widgets) {
      const { row, column, rowSpan, columnSpan } = w.position;
      expect(column + columnSpan).toBeLessThanOrEqual(12);
      for (let r = row; r < row + rowSpan; r++) {
        for (let c = column; c < column + columnSpan; c++) {
          const key = `${r}:${c}`;
          expect(cells.has(key), `${w.title} overlaps at ${key}`).toBe(false);
          cells.add(key);
        }
      }
    }
  });

  it('points every chart at fields of agentOsDailyMetric, with a filter group per widget', () => {
    const charts = widgets.filter((w) => w.type === 'GRAPH');
    expect(charts).toHaveLength(12);
    const groupIds = new Set<string>();
    for (const w of charts) {
      expect(w.objectUniversalIdentifier).toBe(AGENT_OS_DAILY_METRIC_OBJECT_UNIVERSAL_IDENTIFIER);
      expect(dailyFieldIds.has(w.configuration.aggregateFieldMetadataUniversalIdentifier as string)).toBe(true);
      const filter = w.configuration.filter!;
      for (const f of filter.recordFilters) {
        expect(f.fieldMetadataUniversalIdentifier).toBe(AGENT_OS_DAILY_METRIC_FIELD_IDS.day);
        expect(filter.recordFilterGroups.map((g) => g.id)).toContain(f.recordFilterGroupId);
      }
      for (const g of filter.recordFilterGroups) {
        expect(groupIds.has(g.id), `${w.title} reuses filter group ${g.id}`).toBe(false);
        groupIds.add(g.id);
      }
      if (w.configuration.configurationType === 'BAR_CHART') {
        expect(w.configuration.primaryAxisGroupByFieldMetadataUniversalIdentifier).toBe(AGENT_OS_DAILY_METRIC_FIELD_IDS.day);
        expect(w.configuration.layout).toBe('VERTICAL');
      }
    }
  });

  it('builds "last N days" as today OR the previous N-1 days', () => {
    const f = lastDaysFilter('g', 7);
    expect(f.recordFilterGroups).toEqual([{ id: 'g', logicalOperator: 'OR' }]);
    expect(f.recordFilters.map((r) => [r.operand, r.value])).toEqual([
      ['IS_TODAY', ''],
      ['IS_RELATIVE', 'PAST_6_DAY;;Europe/Madrid;;MONDAY;;'],
    ]);
  });

  it('shows the latest agent runs through the TABLE_WIDGET view, newest first, without [TEST] runs', () => {
    const table = widgets.find((w) => w.universalIdentifier === METRICS_PAGE_IDS.widgetLatestRuns)!;
    expect(table.type).toBe('RECORD_TABLE');
    expect(table.objectUniversalIdentifier).toBe(AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER);
    expect(table.configuration.viewUniversalIdentifier).toBe(LATEST_AGENT_RUNS_VIEW_IDS.view);
    const view = latestRunsView.config;
    expect(view.type).toBe('TABLE_WIDGET');
    expect(view.sorts?.[0]).toMatchObject({ fieldMetadataUniversalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.startedAt, direction: 'DESC' });
    expect(view.filters?.[0]).toMatchObject({ fieldMetadataUniversalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.task, operand: 'DOES_NOT_CONTAIN', value: '[TEST]' });
  });

  it('declares a unique day key on the daily metric object (the runtime upserts by it)', () => {
    const dayKey = dailyMetricObject.config.fields.find((f) => f.name === 'dayKey');
    expect(dayKey?.isUnique).toBe(true);
    expect(dailyMetricObject.config.isUIEditable).toBe(false);
  });

  it('links the runtime dashboard on loopback only', () => {
    expect(runtimeDashboardItem.config.type).toBe('LINK');
    expect(runtimeDashboardItem.config.link).toBe('http://127.0.0.1:4020/dashboard');
  });
});
