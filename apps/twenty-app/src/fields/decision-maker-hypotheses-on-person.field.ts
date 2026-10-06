import {
  defineField,
  FieldType,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  COMMERCIAL_HYPOTHESIS_FIELD_IDS,
  PERSON_REVERSE_FIELD_IDS,
} from 'src/constants/field-universal-identifiers';
import { COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Lado ONE_TO_MANY en el objeto estándar person. Twenty exige declarar ambos lados.
export default defineField({
  universalIdentifier: PERSON_REVERSE_FIELD_IDS.decisionMakerHypotheses,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  type: FieldType.RELATION,
  name: 'decisionMakerHypotheses',
  label: 'Hypotheses (decision maker)',
  icon: 'IconBulb',
  relationTargetObjectMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  relationTargetFieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.decisionMaker,
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
