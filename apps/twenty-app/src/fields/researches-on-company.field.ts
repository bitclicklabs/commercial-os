import {
  defineField,
  FieldType,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  RESEARCH_FIELD_IDS,
  COMPANY_REVERSE_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import { RESEARCH_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Lado ONE_TO_MANY en el objeto estándar company. Twenty exige declarar ambos lados.
export default defineField({
  universalIdentifier: COMPANY_REVERSE_FIELD_IDS.researches,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
  type: FieldType.RELATION,
  name: 'researches',
  label: 'Research',
  icon: 'IconFileSearch',
  relationTargetObjectMetadataUniversalIdentifier: RESEARCH_OBJECT_UNIVERSAL_IDENTIFIER,
  relationTargetFieldMetadataUniversalIdentifier: RESEARCH_FIELD_IDS.company,
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
