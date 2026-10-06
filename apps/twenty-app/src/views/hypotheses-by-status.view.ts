import { defineView, ViewType } from 'twenty-sdk/define';

import { CommercialHypothesisStatus } from 'src/constants/commercial-hypothesis-status';
import { COMMERCIAL_HYPOTHESIS_FIELD_IDS } from 'src/constants/field-universal-identifiers';
import { HYPOTHESES_BY_STATUS_VIEW_IDS as IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Vista adicional (la vista "All" la provisiona el servidor): tablero de
// validación de hipótesis por estado, para el HITL comercial del MVP-0.
export default defineView({
  universalIdentifier: IDS.view,
  name: 'By status',
  objectUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.KANBAN,
  icon: 'IconLayoutKanban',
  position: 1,
  mainGroupByFieldMetadataUniversalIdentifier:
    COMMERCIAL_HYPOTHESIS_FIELD_IDS.status,
  fields: [
    { universalIdentifier: IDS.fieldName, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.name, position: 0, isVisible: true, size: 220 },
    { universalIdentifier: IDS.fieldNeed, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.need, position: 1, isVisible: true, size: 240 },
    { universalIdentifier: IDS.fieldCompany, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.company, position: 2, isVisible: true, size: 180 },
    { universalIdentifier: IDS.fieldStatus, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.status, position: 3, isVisible: true, size: 120 },
    { universalIdentifier: IDS.fieldConfidence, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.confidence, position: 4, isVisible: true, size: 100 },
    { universalIdentifier: IDS.fieldBudgetMax, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.budgetMax, position: 5, isVisible: true, size: 140 },
    { universalIdentifier: IDS.fieldTiming, fieldMetadataUniversalIdentifier: COMMERCIAL_HYPOTHESIS_FIELD_IDS.timing, position: 6, isVisible: true, size: 160 },
  ],
  groups: [
    { universalIdentifier: IDS.groupProposed, fieldValue: CommercialHypothesisStatus.PROPOSED, position: 0, isVisible: true },
    { universalIdentifier: IDS.groupValidated, fieldValue: CommercialHypothesisStatus.VALIDATED, position: 1, isVisible: true },
    { universalIdentifier: IDS.groupRejected, fieldValue: CommercialHypothesisStatus.REJECTED, position: 2, isVisible: true },
    { universalIdentifier: IDS.groupExpired, fieldValue: CommercialHypothesisStatus.EXPIRED, position: 3, isVisible: true },
  ],
});
