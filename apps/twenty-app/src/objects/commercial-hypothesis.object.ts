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
  PERSON_REVERSE_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import {
  COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/object-universal-identifiers';
import { CommercialHypothesisStatus } from 'src/constants/commercial-hypothesis-status';

const EUR_EMPTY_AMOUNT = { amountMicros: null, currencyCode: "'EUR'" };

export default defineObject({
  universalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'commercialHypothesis',
  namePlural: 'commercialHypotheses',
  labelSingular: 'Hypothesis',
  labelPlural: 'Hypotheses',
  description:
    'Commercial hypothesis proposed by an agent (need, why now, budget, products) and validated by sales.',
  icon: 'IconBulb',
  labelIdentifierFieldMetadataUniversalIdentifier:
    COMMERCIAL_HYPOTHESIS_FIELD_IDS.name,
  fields: [
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Hypothesis',
      description: 'Short headline (not in LLD; record label). E.g. "500 lanyards for FITUR 2027".',
      icon: 'IconAbc',
      isSearchable: true,
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.need,
      type: FieldType.TEXT,
      name: 'need',
      label: 'Need',
      icon: 'IconTarget',
      isSearchable: true,
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.whyNow,
      type: FieldType.TEXT,
      name: 'whyNow',
      label: 'Why now',
      icon: 'IconClockExclamation',
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.quantityMin,
      type: FieldType.NUMBER,
      name: 'quantityMin',
      label: 'Quantity min',
      icon: 'IconArrowBarToDown',
      universalSettings: { dataType: NumberDataType.INT, decimals: 0 },
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.quantityMax,
      type: FieldType.NUMBER,
      name: 'quantityMax',
      label: 'Quantity max',
      icon: 'IconArrowBarToUp',
      universalSettings: { dataType: NumberDataType.INT, decimals: 0 },
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.budgetMin,
      type: FieldType.CURRENCY,
      name: 'budgetMin',
      label: 'Budget min',
      icon: 'IconCurrencyEuro',
      defaultValue: EUR_EMPTY_AMOUNT,
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.budgetMax,
      type: FieldType.CURRENCY,
      name: 'budgetMax',
      label: 'Budget max',
      icon: 'IconCurrencyEuro',
      defaultValue: EUR_EMPTY_AMOUNT,
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.recommendedProducts,
      type: FieldType.ARRAY,
      name: 'recommendedProducts',
      label: 'Recommended products',
      description: 'Product references (SKU/ID) from the Catalog Service [C2].',
      icon: 'IconPackage',
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.timing,
      type: FieldType.TEXT,
      name: 'timing',
      label: 'Timing',
      description: 'Expected purchase window, free text (e.g. "Q1 2027, before the fair").',
      icon: 'IconCalendarTime',
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.confidence,
      type: FieldType.NUMBER,
      name: 'confidence',
      label: 'Confidence',
      description: 'Agent confidence, 0 to 1.',
      icon: 'IconGauge',
      universalSettings: { dataType: NumberDataType.FLOAT, decimals: 2 },
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.evidence,
      type: FieldType.RAW_JSON,
      name: 'evidence',
      label: 'Evidence',
      description: 'Array of evidence items, e.g. [{ "claim", "sourceUrl", "quote" }].',
      icon: 'IconListCheck',
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.status,
      type: FieldType.SELECT,
      name: 'status',
      label: 'Status',
      icon: 'IconProgressCheck',
      defaultValue: `'${CommercialHypothesisStatus.PROPOSED}'`,
      options: [
        { value: CommercialHypothesisStatus.PROPOSED, label: 'Proposed', position: 0, color: 'sky' },
        { value: CommercialHypothesisStatus.VALIDATED, label: 'Validated', position: 1, color: 'green' },
        { value: CommercialHypothesisStatus.REJECTED, label: 'Rejected', position: 2, color: 'red' },
        { value: CommercialHypothesisStatus.EXPIRED, label: 'Expired', position: 3, color: 'gray' },
      ],
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.tenantId,
      type: FieldType.TEXT,
      name: 'tenantId',
      label: 'Tenant ID',
      description: 'LLD [C6] tenant_id, mirrors the Agent OS tenant.',
      icon: 'IconBuildingCommunity',
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.company,
      type: FieldType.RELATION,
      name: 'company',
      label: 'Company',
      icon: 'IconBuildingSkyscraper',
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        COMPANY_REVERSE_FIELD_IDS.commercialHypotheses,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'companyId',
      },
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.commercialSignal,
      type: FieldType.RELATION,
      name: 'commercialSignal',
      label: 'Signal',
      icon: 'IconBroadcast',
      relationTargetObjectMetadataUniversalIdentifier:
        COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        COMMERCIAL_SIGNAL_FIELD_IDS.commercialHypotheses,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'commercialSignalId',
      },
    },
    {
      universalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.decisionMaker,
      type: FieldType.RELATION,
      name: 'decisionMaker',
      label: 'Decision maker',
      description: 'LLD decision_maker_id.',
      icon: 'IconUserStar',
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        PERSON_REVERSE_FIELD_IDS.decisionMakerHypotheses,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'decisionMakerId',
      },
    },
  ],
});
