import {
  defineField,
  FieldType,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  COMMERCIAL_HYPOTHESIS_FIELD_IDS,
  COMPANY_REVERSE_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import { COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Lado ONE_TO_MANY en el objeto estándar company. Twenty exige declarar ambos lados.
export default defineField({
  universalIdentifier: COMPANY_REVERSE_FIELD_IDS.commercialHypotheses,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
  type: FieldType.RELATION,
  name: 'commercialHypotheses',
  label: 'Hypotheses',
  icon: 'IconBulb',
  relationTargetObjectMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  relationTargetFieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.company,
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
