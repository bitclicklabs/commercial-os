import { defineObject, FieldType, NumberDataType } from 'twenty-sdk/define';

import { AGENT_OS_DAILY_METRIC_FIELD_IDS as F } from 'src/constants/field-universal-identifiers';
import { AGENT_OS_DAILY_METRIC_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

enum AgentOsWarmupStage {
  BEFORE = 'BEFORE',
  WARMUP = 'WARMUP',
  POST_WARMUP = 'POST_WARMUP',
}

const INT = { dataType: NumberDataType.INT, decimals: 0 } as const;

// Métricas agregadas del Agent OS, un registro por tenant y día local (Europe/Madrid).
// Solo lectura en la UI: las escribe el runtime (src/metrics/twenty-sync.ts) cada pocos
// minutos con las mismas consultas que /metrics/summary. Alimentan los gráficos nativos de
// la página «Agent OS · Métricas» (docs/estudio-dashboard-twenty.md).
export default defineObject({
  universalIdentifier: AGENT_OS_DAILY_METRIC_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'agentOsDailyMetric',
  namePlural: 'agentOsDailyMetrics',
  labelSingular: 'Agent OS metric',
  labelPlural: 'Agent OS metrics',
  description:
    'Daily aggregated metrics of the Agent OS (runs, cost, sends, warm-up target, acceptance). Written by the Agent OS.',
  icon: 'IconChartBar',
  isUICreatable: false,
  isUIEditable: false,
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    {
      universalIdentifier: F.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Day',
      description: 'Record label, e.g. "2026-10-07 · publiexpe".',
      icon: 'IconAbc',
      isSearchable: true,
    },
    {
      universalIdentifier: F.day,
      type: FieldType.DATE,
      name: 'day',
      label: 'Date',
      description: 'Local day (Europe/Madrid) the metrics refer to.',
      icon: 'IconCalendar',
    },
    {
      universalIdentifier: F.dayKey,
      type: FieldType.TEXT,
      name: 'dayKey',
      label: 'Day key',
      description: 'Idempotency key "<tenant>:<YYYY-MM-DD>"; the Agent OS upserts by it.',
      icon: 'IconKey',
      isUnique: true,
    },
    {
      universalIdentifier: F.tenantId,
      type: FieldType.TEXT,
      name: 'tenantId',
      label: 'Tenant ID',
      description: 'LLD [C6] tenant_id, mirrors the Agent OS tenant.',
      icon: 'IconBuildingCommunity',
    },
    {
      universalIdentifier: F.runs,
      type: FieldType.NUMBER,
      name: 'runs',
      label: 'Runs',
      description: 'TaskRuns created that day (every task, archived agents included, as /metrics/summary).',
      icon: 'IconPlayerPlay',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.runsSucceeded,
      type: FieldType.NUMBER,
      name: 'runsSucceeded',
      label: 'Runs succeeded',
      description: 'Runs of the day with outcome SUCCESS.',
      icon: 'IconCircleCheck',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.runsFailed,
      type: FieldType.NUMBER,
      name: 'runsFailed',
      label: 'Runs failed',
      description: 'Runs of the day with status FAILED or TIMED_OUT.',
      icon: 'IconAlertTriangle',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.cost,
      type: FieldType.CURRENCY,
      name: 'cost',
      label: 'Cost',
      description: 'Model cost of the runs of the day, in EUR (sum of every attempt).',
      icon: 'IconCoin',
      defaultValue: { amountMicros: null, currencyCode: "'EUR'" },
      universalSettings: { decimals: 3 },
    },
    {
      universalIdentifier: F.hypothesesCreated,
      type: FieldType.NUMBER,
      name: 'hypothesesCreated',
      label: 'Hypotheses created',
      icon: 'IconBulb',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.emailSends,
      type: FieldType.NUMBER,
      name: 'emailSends',
      label: 'Email sends',
      description: 'Emails sent from Twenty that day (email_sends). Webmail sends are not counted.',
      icon: 'IconSend',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.warmupTarget,
      type: FieldType.NUMBER,
      name: 'warmupTarget',
      label: 'Warm-up target',
      description: 'Soft daily target of the warm-up (both mailboxes). Empty before and after the warm-up.',
      icon: 'IconTarget',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.warmupStage,
      type: FieldType.SELECT,
      name: 'warmupStage',
      label: 'Warm-up stage',
      icon: 'IconFlame',
      options: [
        { value: AgentOsWarmupStage.BEFORE, label: 'Before warm-up', position: 0, color: 'gray' },
        { value: AgentOsWarmupStage.WARMUP, label: 'Warm-up', position: 1, color: 'orange' },
        { value: AgentOsWarmupStage.POST_WARMUP, label: 'Post warm-up', position: 2, color: 'green' },
      ],
    },
    {
      universalIdentifier: F.warmupPhase,
      type: FieldType.TEXT,
      name: 'warmupPhase',
      label: 'Warm-up phase',
      icon: 'IconStairsUp',
    },
    {
      universalIdentifier: F.humanReviewed,
      type: FieldType.NUMBER,
      name: 'humanReviewed',
      label: 'Human reviewed',
      description: 'Subjects with a human verdict that day (latest verdict per subject).',
      icon: 'IconEye',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.humanAccepted,
      type: FieldType.NUMBER,
      name: 'humanAccepted',
      label: 'Human accepted',
      description: 'Of those, subjects whose latest verdict is ACCEPTED.',
      icon: 'IconThumbUp',
      universalSettings: INT,
    },
    {
      universalIdentifier: F.acceptanceRate,
      type: FieldType.NUMBER,
      name: 'acceptanceRate',
      label: 'Acceptance rate (to date)',
      description: 'Cumulative human acceptance up to the end of the day, in percent (0-100). Empty without verdicts.',
      icon: 'IconPercentage',
      universalSettings: { dataType: NumberDataType.FLOAT, decimals: 1 },
    },
    {
      universalIdentifier: F.syncedAt,
      type: FieldType.DATE_TIME,
      name: 'syncedAt',
      label: 'Synced at',
      description: 'Last time the Agent OS refreshed this record.',
      icon: 'IconRefresh',
    },
  ],
});
