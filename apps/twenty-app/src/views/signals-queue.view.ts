import { defineView, ViewType } from 'twenty-sdk/define';

import { COMMERCIAL_SIGNAL_FIELD_IDS as F } from 'src/constants/field-universal-identifiers';
import { SIGNALS_QUEUE_VIEW_IDS as IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';

// Valores del SELECT `status` de Signal (src/objects/commercial-signal.object.ts).
export const SIGNAL_QUEUE_STATUSES = ['NEW', 'REVIEWING', 'QUALIFIED', 'DISCARDED', 'EXPIRED'] as const;

// Tanda 19 — «Señales · Cola»: kanban de señales por estado para la revisión comercial
// (calificar o descartar). Es solo una vista: no cambia el objeto ni sus campos. Twenty trae de
// serie los kanban de Oportunidades («By Stage») y Tareas («By Status»), así que no se duplican;
// el de Hipótesis por estado ya existe desde la tanda 9 (hypotheses-by-status.view.ts).
export default defineView({
  universalIdentifier: IDS.view,
  name: 'Señales · Cola',
  objectUniversalIdentifier: COMMERCIAL_SIGNAL_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.KANBAN,
  icon: 'IconLayoutKanban',
  position: 2,
  mainGroupByFieldMetadataUniversalIdentifier: F.status,
  fields: [
    { universalIdentifier: IDS.fieldName, fieldMetadataUniversalIdentifier: F.name, position: 0, isVisible: true, size: 260 },
    { universalIdentifier: IDS.fieldCompany, fieldMetadataUniversalIdentifier: F.company, position: 1, isVisible: true, size: 180 },
    { universalIdentifier: IDS.fieldSignalType, fieldMetadataUniversalIdentifier: F.signalType, position: 2, isVisible: true, size: 130 },
    { universalIdentifier: IDS.fieldEventDate, fieldMetadataUniversalIdentifier: F.eventDate, position: 3, isVisible: true, size: 130 },
    { universalIdentifier: IDS.fieldConfidence, fieldMetadataUniversalIdentifier: F.confidence, position: 4, isVisible: true, size: 100 },
    { universalIdentifier: IDS.fieldDetectedAt, fieldMetadataUniversalIdentifier: F.detectedAt, position: 5, isVisible: true, size: 150 },
    { universalIdentifier: IDS.fieldStatus, fieldMetadataUniversalIdentifier: F.status, position: 6, isVisible: true, size: 120 },
  ],
  groups: [
    { universalIdentifier: IDS.groupNew, fieldValue: 'NEW', position: 0, isVisible: true },
    { universalIdentifier: IDS.groupReviewing, fieldValue: 'REVIEWING', position: 1, isVisible: true },
    { universalIdentifier: IDS.groupQualified, fieldValue: 'QUALIFIED', position: 2, isVisible: true },
    { universalIdentifier: IDS.groupDiscarded, fieldValue: 'DISCARDED', position: 3, isVisible: true },
    { universalIdentifier: IDS.groupExpired, fieldValue: 'EXPIRED', position: 4, isVisible: true },
  ],
});
