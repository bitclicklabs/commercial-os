import {
  defineObject,
  FieldType,
  OnDeleteAction,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  AGENT_RUN_SUMMARY_FIELD_IDS,
  COMPANY_REVERSE_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import { AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

enum AgentRunOutcome {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// LLD §4 [C1] — vista comercial de una ejecución. Solo lectura para el
// comercial: no se crea ni se edita desde la UI; lo escribe el Agent OS vía API.
// El detalle (trace, pasos, coste desglosado) vive en el Agent OS.
export default defineObject({
  universalIdentifier: AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'agentRunSummary',
  namePlural: 'agentRunSummaries',
  labelSingular: 'Agent run',
  labelPlural: 'Agent runs',
  description:
    'Read-only summary of an agent execution. Full trace lives in the Agent OS.',
  icon: 'IconRobot',
  isUICreatable: false,
  isUIEditable: false,
  labelIdentifierFieldMetadataUniversalIdentifier:
    AGENT_RUN_SUMMARY_FIELD_IDS.name,
  fields: [
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Run',
      description: 'Short label (not in LLD; record label). E.g. "PROSPECTOR v1.8 · ACME".',
      icon: 'IconAbc',
      isSearchable: true,
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.task,
      type: FieldType.TEXT,
      name: 'task',
      label: 'Task',
      icon: 'IconChecklist',
      isSearchable: true,
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.agentName,
      type: FieldType.TEXT,
      name: 'agentName',
      label: 'Agent',
      icon: 'IconRobot',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.agentVersion,
      type: FieldType.TEXT,
      name: 'agentVersion',
      label: 'Agent version',
      icon: 'IconVersions',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.outcome,
      type: FieldType.SELECT,
      name: 'outcome',
      label: 'Outcome',
      icon: 'IconFlag',
      defaultValue: `'${AgentRunOutcome.SUCCESS}'`,
      options: [
        { value: AgentRunOutcome.SUCCESS, label: 'Success', position: 0, color: 'green' },
        { value: AgentRunOutcome.PARTIAL, label: 'Partial', position: 1, color: 'orange' },
        { value: AgentRunOutcome.FAILED, label: 'Failed', position: 2, color: 'red' },
        { value: AgentRunOutcome.CANCELLED, label: 'Cancelled', position: 3, color: 'gray' },
      ],
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.resultSummary,
      type: FieldType.TEXT,
      name: 'resultSummary',
      label: 'Result',
      icon: 'IconAlignLeft',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.cost,
      type: FieldType.CURRENCY,
      name: 'cost',
      label: 'Cost',
      icon: 'IconCoin',
      defaultValue: { amountMicros: null, currencyCode: "'EUR'" },
      universalSettings: { decimals: 3 },
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.traceUrl,
      type: FieldType.LINKS,
      name: 'traceUrl',
      label: 'Trace',
      description: 'Link to the full trace in the Agent OS.',
      icon: 'IconTimeline',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.agentExecutionId,
      type: FieldType.TEXT,
      name: 'agentExecutionId',
      label: 'Agent execution ID',
      description: 'External reference to AgentExecution in the Agent OS.',
      icon: 'IconFingerprint',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.startedAt,
      type: FieldType.DATE_TIME,
      name: 'startedAt',
      label: 'Started at',
      icon: 'IconPlayerPlay',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.finishedAt,
      type: FieldType.DATE_TIME,
      name: 'finishedAt',
      label: 'Finished at',
      icon: 'IconPlayerStop',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.tenantId,
      type: FieldType.TEXT,
      name: 'tenantId',
      label: 'Tenant ID',
      description: 'LLD [C6] tenant_id, mirrors the Agent OS tenant.',
      icon: 'IconBuildingCommunity',
    },
    {
      universalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.company,
      type: FieldType.RELATION,
      name: 'company',
      label: 'Company',
      icon: 'IconBuildingSkyscraper',
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        COMPANY_REVERSE_FIELD_IDS.agentRunSummaries,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'companyId',
      },
    },
  ],
});
