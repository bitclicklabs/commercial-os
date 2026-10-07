import {
  AggregateOperations,
  definePageLayout,
  ObjectRecordGroupByDateGranularity,
  PageLayoutTabLayoutMode,
  PageLayoutType,
  WidgetType,
} from 'twenty-sdk/define';

import {
  AGENT_OS_DAILY_METRIC_FIELD_IDS as M,
} from 'src/constants/field-universal-identifiers';
import {
  LATEST_AGENT_RUNS_VIEW_IDS,
  METRICS_CHART_FILTER_GROUP_IDS as G,
  METRICS_PAGE_IDS as IDS,
} from 'src/constants/layout-universal-identifiers';
import {
  AGENT_OS_DAILY_METRIC_OBJECT_UNIVERSAL_IDENTIFIER as DAILY,
  AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER as RUNS,
} from 'src/constants/object-universal-identifiers';

// Página «Agent OS · Métricas»: la versión nativa en Twenty del /dashboard del runtime
// (docs/estudio-dashboard-twenty.md). Widgets GRAPH sobre agentOsDailyMetric (lo escribe el
// runtime) y una tabla con los últimos agentRunSummary. STANDALONE_PAGE porque es el único
// tipo de page layout que una entrada de navegación PAGE_LAYOUT puede abrir (validado por el
// servidor 2.45); su pestaña GRID usa el mismo renderizador que los Dashboards.

export const METRICS_TIMEZONE = 'Europe/Madrid';

type Filter = {
  recordFilters: {
    fieldMetadataUniversalIdentifier: string;
    operand: string;
    value: string;
    type: string;
    recordFilterGroupId: string;
  }[];
  recordFilterGroups: { id: string; logicalOperator: string }[];
};

const todayFilter = (groupId: string): Filter => ({
  recordFilters: [
    { fieldMetadataUniversalIdentifier: M.day, operand: 'IS_TODAY', value: '', type: 'DATE', recordFilterGroupId: groupId },
  ],
  recordFilterGroups: [{ id: groupId, logicalOperator: 'AND' }],
});

/** Today OR the previous `days - 1` days: `PAST_N_DAY` ends before today (twenty-shared). */
export const lastDaysFilter = (groupId: string, days: number): Filter => ({
  recordFilters: [
    { fieldMetadataUniversalIdentifier: M.day, operand: 'IS_TODAY', value: '', type: 'DATE', recordFilterGroupId: groupId },
    {
      fieldMetadataUniversalIdentifier: M.day,
      operand: 'IS_RELATIVE',
      value: `PAST_${days - 1}_DAY;;${METRICS_TIMEZONE};;MONDAY;;`,
      type: 'DATE',
      recordFilterGroupId: groupId,
    },
  ],
  recordFilterGroups: [{ id: groupId, logicalOperator: 'OR' }],
});

const grid = (row: number, column: number, rowSpan: number, columnSpan: number) => ({
  layoutMode: PageLayoutTabLayoutMode.GRID as const,
  row,
  column,
  rowSpan,
  columnSpan,
});

type Kpi = {
  id: string;
  title: string;
  field: string;
  operation: AggregateOperations;
  filter: Filter;
  row: number;
  column: number;
  suffix?: string;
  description: string;
};

const kpi = (k: Kpi) => ({
  universalIdentifier: k.id,
  title: k.title,
  type: WidgetType.GRAPH,
  objectUniversalIdentifier: DAILY,
  position: grid(k.row, k.column, 2, 3),
  configuration: {
    configurationType: 'AGGREGATE_CHART' as const,
    aggregateFieldMetadataUniversalIdentifier: k.field,
    aggregateOperation: k.operation,
    description: k.description,
    timezone: METRICS_TIMEZONE,
    filter: k.filter,
    ...(k.suffix ? { suffix: k.suffix } : {}),
  },
});

type DailyBar = {
  id: string;
  title: string;
  field: string;
  filterGroupId: string;
  row: number;
  column: number;
  color: string;
  description: string;
};

const dailyBar = (b: DailyBar) => ({
  universalIdentifier: b.id,
  title: b.title,
  type: WidgetType.GRAPH,
  objectUniversalIdentifier: DAILY,
  position: grid(b.row, b.column, 6, 6),
  configuration: {
    configurationType: 'BAR_CHART' as const,
    aggregateFieldMetadataUniversalIdentifier: b.field,
    aggregateOperation: AggregateOperations.SUM,
    primaryAxisGroupByFieldMetadataUniversalIdentifier: M.day,
    primaryAxisDateGranularity: ObjectRecordGroupByDateGranularity.DAY,
    primaryAxisOrderBy: 'FIELD_ASC',
    layout: 'VERTICAL',
    displayDataLabel: true,
    omitNullValues: false,
    color: b.color,
    description: b.description,
    timezone: METRICS_TIMEZONE,
    filter: lastDaysFilter(b.filterGroupId, 14),
  },
});

const NOTES_MARKDOWN = [
  '**Fuente:** el Agent OS (runtime) escribe un registro *Agent OS metric* por día cada 15 minutos con las mismas consultas que `/metrics/summary`. «Hoy» y «7 días» son días locales de Europe/Madrid; los 7 días incluyen hoy.',
  '**Aceptación:** último veredicto humano por sujeto, acumulado hasta hoy. **Envíos:** solo los enviados desde Twenty; los del webmail no cuentan. **Objetivo warm-up:** suma de ambos buzones; vacío fuera del warm-up.',
  '**Detalle técnico** (por agente y versión, latencias, trazas JSON): http://127.0.0.1:4020/dashboard — solo desde este equipo.',
];

const blocknoteParagraph = (index: number, text: string) => ({
  id: `agent-os-metrics-note-${index}`,
  type: 'paragraph',
  props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
  content: [{ type: 'text', text: text.replace(/\*\*|\*|`/g, ''), styles: {} }],
  children: [],
});

export default definePageLayout({
  universalIdentifier: IDS.pageLayout,
  name: 'Agent OS · Métricas',
  type: PageLayoutType.STANDALONE_PAGE,
  tabs: [
    {
      universalIdentifier: IDS.tab,
      title: 'Resumen',
      position: 0,
      icon: 'IconChartBar',
      layoutMode: PageLayoutTabLayoutMode.GRID,
      widgets: [
        // Fila 1: runs y coste.
        kpi({ id: IDS.widgetRunsToday, title: 'Runs hoy', field: M.runs, operation: AggregateOperations.SUM, filter: todayFilter(G.runsToday), row: 0, column: 0, description: 'TaskRuns creados hoy.' }),
        kpi({ id: IDS.widgetRuns7d, title: 'Runs 7 días', field: M.runs, operation: AggregateOperations.SUM, filter: lastDaysFilter(G.runs7d, 7), row: 0, column: 3, description: 'Hoy y los 6 días anteriores.' }),
        kpi({ id: IDS.widgetCostToday, title: 'Coste hoy', field: M.cost, operation: AggregateOperations.SUM, filter: todayFilter(G.costToday), row: 0, column: 6, description: 'Coste de modelo de los runs de hoy, en EUR.' }),
        kpi({ id: IDS.widgetCost7d, title: 'Coste 7 días', field: M.cost, operation: AggregateOperations.SUM, filter: lastDaysFilter(G.cost7d, 7), row: 0, column: 9, description: 'Hoy y los 6 días anteriores, en EUR.' }),
        // Fila 2: aceptación y email.
        kpi({ id: IDS.widgetAcceptance, title: 'Tasa de aceptación', field: M.acceptanceRate, operation: AggregateOperations.MAX, filter: todayFilter(G.acceptance), row: 2, column: 0, suffix: '%', description: 'Veredictos ACCEPTED / revisados, último veredicto por sujeto, acumulado.' }),
        kpi({ id: IDS.widgetSendsToday, title: 'Envíos hoy', field: M.emailSends, operation: AggregateOperations.SUM, filter: todayFilter(G.sendsToday), row: 2, column: 3, description: 'Emails enviados hoy desde Twenty.' }),
        kpi({ id: IDS.widgetWarmupTargetToday, title: 'Objetivo warm-up hoy', field: M.warmupTarget, operation: AggregateOperations.SUM, filter: todayFilter(G.warmupTargetToday), row: 2, column: 6, description: 'Tope blando del día, ambos buzones (0 en fin de semana).' }),
        kpi({ id: IDS.widgetSends7d, title: 'Envíos 7 días', field: M.emailSends, operation: AggregateOperations.SUM, filter: lastDaysFilter(G.sends7d, 7), row: 2, column: 9, description: 'Hoy y los 6 días anteriores.' }),
        // Envíos frente a objetivo, 14 días.
        dailyBar({ id: IDS.widgetSendsByDay, title: 'Envíos por día (14 días)', field: M.emailSends, filterGroupId: G.sendsByDay, row: 4, column: 0, color: 'blue', description: 'Compáralo con el objetivo de warm-up de al lado.' }),
        dailyBar({ id: IDS.widgetWarmupTargetByDay, title: 'Objetivo warm-up por día (14 días)', field: M.warmupTarget, filterGroupId: G.warmupTargetByDay, row: 4, column: 6, color: 'orange', description: 'Tope blando diario del calendario de warm-up.' }),
        // Coste y runs, 14 días.
        dailyBar({ id: IDS.widgetCostByDay, title: 'Coste por día (14 días)', field: M.cost, filterGroupId: G.costByDay, row: 10, column: 0, color: 'purple', description: 'EUR por día.' }),
        dailyBar({ id: IDS.widgetRunsByDay, title: 'Runs por día (14 días)', field: M.runs, filterGroupId: G.runsByDay, row: 10, column: 6, color: 'turquoise', description: 'TaskRuns por día.' }),
        // Últimos runs (registros reales de Twenty, con enlace a la traza).
        {
          universalIdentifier: IDS.widgetLatestRuns,
          title: 'Últimos runs',
          type: WidgetType.RECORD_TABLE,
          objectUniversalIdentifier: RUNS,
          position: grid(16, 0, 8, 12),
          configuration: {
            configurationType: 'RECORD_TABLE' as const,
            viewUniversalIdentifier: LATEST_AGENT_RUNS_VIEW_IDS.view,
            recordLimit: 10,
            isUIEditable: false,
          },
        },
        {
          universalIdentifier: IDS.widgetNotes,
          title: 'Cómo leer esta página',
          type: WidgetType.STANDALONE_RICH_TEXT,
          position: grid(24, 0, 3, 12),
          configuration: {
            configurationType: 'STANDALONE_RICH_TEXT' as const,
            body: {
              markdown: NOTES_MARKDOWN.join('\n\n'),
              blocknote: JSON.stringify(NOTES_MARKDOWN.map((text, i) => blocknoteParagraph(i, text))),
            },
          },
        },
      ],
    },
  ],
});
