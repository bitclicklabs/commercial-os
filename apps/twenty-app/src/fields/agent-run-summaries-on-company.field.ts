import {
  defineField,
  FieldType,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  AGENT_RUN_SUMMARY_FIELD_IDS,
  COMPANY_REVERSE_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import { AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Lado ONE_TO_MANY en el objeto estándar company. Twenty exige declarar ambos lados.
export default defineField({
  universalIdentifier: COMPANY_REVERSE_FIELD_IDS.agentRunSummaries,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
  type: FieldType.RELATION,
  name: 'agentRunSummaries',
  label: 'Agent runs',
  icon: 'IconRobot',
  relationTargetObjectMetadataUniversalIdentifier: AGENT_RUN_SUMMARY_OBJECT_UNIVERSAL_IDENTIFIER,
  relationTargetFieldMetadataUniversalIdentifier: AGENT_RUN_SUMMARY_FIELD_IDS.company,
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
