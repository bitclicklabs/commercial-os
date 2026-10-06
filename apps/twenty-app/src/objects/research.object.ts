import {
  defineObject,
  FieldType,
  NumberDataType,
  OnDeleteAction,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  COMMERCIAL_SIGNAL_FIELD_IDS,
  COMPANY_REVERSE_FIELD_IDS,
  RESEARCH_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import {
  COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
  RESEARCH_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/object-universal-identifiers';

// LLD §5.2 — una investigación no se sobrescribe: nueva investigación = nuevo
// registro. Por eso el objeto no es creable ni editable desde la UI; lo escribe
// el Agent OS vía API.
export default defineObject({
  universalIdentifier: RESEARCH_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'research',
  namePlural: 'researches',
  labelSingular: 'Research',
  labelPlural: 'Research',
  description:
    'Immutable research result produced by an agent execution. A new research is always a new record.',
  icon: 'IconFileSearch',
  isUICreatable: false,
  isUIEditable: false,
  labelIdentifierFieldMetadataUniversalIdentifier: RESEARCH_FIELD_IDS.name,
  fields: [
    {
      universalIdentifier: RESEARCH_FIELD_IDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Title',
      description: 'Human-readable label (not in LLD; required as record label).',
      icon: 'IconAbc',
      isSearchable: true,
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.researchType,
      type: FieldType.TEXT,
      name: 'researchType',
      label: 'Research type',
      icon: 'IconCategory',
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.query,
      type: FieldType.TEXT,
      name: 'query',
      label: 'Query',
      icon: 'IconSearch',
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.summary,
      type: FieldType.TEXT,
      name: 'summary',
      label: 'Summary',
      icon: 'IconAlignLeft',
      isSearchable: true,
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.structuredResult,
      type: FieldType.RAW_JSON,
      name: 'structuredResult',
      label: 'Structured result',
      icon: 'IconBraces',
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.sources,
      type: FieldType.ARRAY,
      name: 'sources',
      label: 'Sources',
      description: 'Source URLs used by the agent.',
      icon: 'IconLink',
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.confidence,
      type: FieldType.NUMBER,
      name: 'confidence',
      label: 'Confidence',
      description: 'Agent confidence, 0 to 1.',
      icon: 'IconGauge',
      universalSettings: { dataType: NumberDataType.FLOAT, decimals: 2 },
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.agentExecutionId,
      type: FieldType.TEXT,
      name: 'agentExecutionId',
      label: 'Agent execution ID',
      description: 'External reference to AgentExecution in the Agent OS.',
      icon: 'IconFingerprint',
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.tenantId,
      type: FieldType.TEXT,
      name: 'tenantId',
      label: 'Tenant ID',
      description: 'LLD [C6] tenant_id, mirrors the Agent OS tenant.',
      icon: 'IconBuildingCommunity',
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.company,
      type: FieldType.RELATION,
      name: 'company',
      label: 'Company',
      icon: 'IconBuildingSkyscraper',
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        COMPANY_REVERSE_FIELD_IDS.researches,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'companyId',
      },
    },
    {
      universalIdentifier: RESEARCH_FIELD_IDS.commercialSignal,
      type: FieldType.RELATION,
      name: 'commercialSignal',
      label: 'Signal',
      icon: 'IconBroadcast',
      relationTargetObjectMetadataUniversalIdentifier:
        COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        COMMERCIAL_SIGNAL_FIELD_IDS.researches,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'commercialSignalId',
      },
    },
  ],
});
