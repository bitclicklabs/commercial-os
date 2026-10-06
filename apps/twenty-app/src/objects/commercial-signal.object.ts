import {
  defineObject,
  FieldType,
  NumberDataType,
  OnDeleteAction,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  COMMERCIAL_HYPOTHESIS_FIELD_IDS,
  COMMERCIAL_SIGNAL_FIELD_IDS,
  COMPANY_REVERSE_FIELD_IDS,
  RESEARCH_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import {
  COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
  RESEARCH_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/object-universal-identifiers';

// LLD §5.1 — tipos de señal comercial.
enum CommercialSignalType {
  FAIR = 'FAIR',
  CONGRESS = 'CONGRESS',
  EVENT = 'EVENT',
  NEW_PRODUCT = 'NEW_PRODUCT',
  HIRING = 'HIRING',
  EXPANSION = 'EXPANSION',
  REBRANDING = 'REBRANDING',
  SPONSORSHIP = 'SPONSORSHIP',
  CAMPAIGN = 'CAMPAIGN',
  ANNIVERSARY = 'ANNIVERSARY',
  OTHER = 'OTHER',
}

// El LLD v0.1 no enumera los estados de la señal: se proponen estos (ver README).
enum CommercialSignalStatus {
  NEW = 'NEW',
  REVIEWING = 'REVIEWING',
  QUALIFIED = 'QUALIFIED',
  DISCARDED = 'DISCARDED',
  EXPIRED = 'EXPIRED',
}

export default defineObject({
  universalIdentifier: COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'commercialSignal',
  namePlural: 'commercialSignals',
  labelSingular: 'Signal',
  labelPlural: 'Signals',
  description:
    'Commercial signal detected for a company (fair, hiring, expansion...). Written by the Agent OS, reviewed by sales.',
  icon: 'IconBroadcast',
  labelIdentifierFieldMetadataUniversalIdentifier:
    COMMERCIAL_SIGNAL_FIELD_IDS.name,
  fields: [
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Title',
      icon: 'IconAbc',
      isSearchable: true,
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.description,
      type: FieldType.TEXT,
      name: 'description',
      label: 'Description',
      icon: 'IconAlignLeft',
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.signalType,
      type: FieldType.SELECT,
      name: 'signalType',
      label: 'Type',
      description: 'LLD field "type" (reserved name in Twenty).',
      icon: 'IconCategory',
      defaultValue: `'${CommercialSignalType.OTHER}'`,
      options: [
        { value: CommercialSignalType.FAIR, label: 'Fair', position: 0, color: 'blue' },
        { value: CommercialSignalType.CONGRESS, label: 'Congress', position: 1, color: 'sky' },
        { value: CommercialSignalType.EVENT, label: 'Event', position: 2, color: 'cyan' },
        { value: CommercialSignalType.NEW_PRODUCT, label: 'New product', position: 3, color: 'green' },
        { value: CommercialSignalType.HIRING, label: 'Hiring', position: 4, color: 'turquoise' },
        { value: CommercialSignalType.EXPANSION, label: 'Expansion', position: 5, color: 'grass' },
        { value: CommercialSignalType.REBRANDING, label: 'Rebranding', position: 6, color: 'purple' },
        { value: CommercialSignalType.SPONSORSHIP, label: 'Sponsorship', position: 7, color: 'orange' },
        { value: CommercialSignalType.CAMPAIGN, label: 'Campaign', position: 8, color: 'amber' },
        { value: CommercialSignalType.ANNIVERSARY, label: 'Anniversary', position: 9, color: 'pink' },
        { value: CommercialSignalType.OTHER, label: 'Other', position: 10, color: 'gray' },
      ],
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.sourceUrl,
      type: FieldType.LINKS,
      name: 'sourceUrl',
      label: 'Source URL',
      icon: 'IconLink',
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.sourceDomain,
      type: FieldType.TEXT,
      name: 'sourceDomain',
      label: 'Source domain',
      icon: 'IconWorld',
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.detectedAt,
      type: FieldType.DATE_TIME,
      name: 'detectedAt',
      label: 'Detected at',
      icon: 'IconRadar',
      defaultValue: 'now',
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.eventDate,
      type: FieldType.DATE,
      name: 'eventDate',
      label: 'Event date',
      icon: 'IconCalendarEvent',
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.confidence,
      type: FieldType.NUMBER,
      name: 'confidence',
      label: 'Confidence',
      description: 'Agent confidence, 0 to 1.',
      icon: 'IconGauge',
      universalSettings: { dataType: NumberDataType.FLOAT, decimals: 2 },
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.status,
      type: FieldType.SELECT,
      name: 'status',
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: `'${CommercialSignalStatus.NEW}'`,
      options: [
        { value: CommercialSignalStatus.NEW, label: 'New', position: 0, color: 'sky' },
        { value: CommercialSignalStatus.REVIEWING, label: 'Reviewing', position: 1, color: 'orange' },
        { value: CommercialSignalStatus.QUALIFIED, label: 'Qualified', position: 2, color: 'green' },
        { value: CommercialSignalStatus.DISCARDED, label: 'Discarded', position: 3, color: 'red' },
        { value: CommercialSignalStatus.EXPIRED, label: 'Expired', position: 4, color: 'gray' },
      ],
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.tenantId,
      type: FieldType.TEXT,
      name: 'tenantId',
      label: 'Tenant ID',
      description: 'LLD [C6] tenant_id, mirrors the Agent OS tenant.',
      icon: 'IconBuildingCommunity',
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.company,
      type: FieldType.RELATION,
      name: 'company',
      label: 'Company',
      icon: 'IconBuildingSkyscraper',
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        COMPANY_REVERSE_FIELD_IDS.commercialSignals,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'companyId',
      },
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.researches,
      type: FieldType.RELATION,
      name: 'researches',
      label: 'Research',
      icon: 'IconFileSearch',
      relationTargetObjectMetadataUniversalIdentifier:
        RESEARCH_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        RESEARCH_FIELD_IDS.commercialSignal,
      universalSettings: {
        relationType: RelationType.ONE_TO_MANY,
      },
    },
    {
      universalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.commercialHypotheses,
      type: FieldType.RELATION,
      name: 'commercialHypotheses',
      label: 'Hypotheses',
      icon: 'IconBulb',
      relationTargetObjectMetadataUniversalIdentifier:
        COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        COMMERCIAL_HYPOTHESIS_FIELD_IDS.commercialSignal,
      universalSettings: {
        relationType: RelationType.ONE_TO_MANY,
      },
    },
  ],
});
