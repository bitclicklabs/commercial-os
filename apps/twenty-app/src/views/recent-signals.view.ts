import { defineView, ViewSortDirection, ViewType } from 'twenty-sdk/define';

import { COMMERCIAL_SIGNAL_FIELD_IDS } from 'src/constants/field-universal-identifiers';
import { RECENT_SIGNALS_VIEW_IDS as IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Vista adicional: señales más recientes primero.
export default defineView({
  universalIdentifier: IDS.view,
  name: 'Recent signals',
  objectUniversalIdentifier: COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.TABLE,
  icon: 'IconClockHour4',
  position: 1,
  fields: [
    { universalIdentifier: IDS.fieldName, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.name, position: 0, isVisible: true, size: 260 },
    { universalIdentifier: IDS.fieldCompany, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.company, position: 1, isVisible: true, size: 180 },
    { universalIdentifier: IDS.fieldSignalType, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.signalType, position: 2, isVisible: true, size: 130 },
    { universalIdentifier: IDS.fieldStatus, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.status, position: 3, isVisible: true, size: 120 },
    { universalIdentifier: IDS.fieldConfidence, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.confidence, position: 4, isVisible: true, size: 100 },
    { universalIdentifier: IDS.fieldEventDate, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.eventDate, position: 5, isVisible: true, size: 130 },
    { universalIdentifier: IDS.fieldDetectedAt, fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.detectedAt, position: 6, isVisible: true, size: 150 },
  ],
  sorts: [
    {
      universalIdentifier: IDS.sortDetectedAt,
      fieldMetadataUniversalIdentifier: COMMERCIAL_SIGNAL_FIELD_IDS.detectedAt,
      direction: ViewSortDirection.DESC,
    },
  ],
});
