import { defineView, getFieldUniversalIdentifier, ViewType } from 'twenty-sdk/define';

import { COMMERCIAL_HYPOTHESIS_FIELD_IDS as F } from 'src/constants/field-universal-identifiers';
import { HYPOTHESES_SENDS_VIEW_IDS as IDS } from 'src/constants/layout-universal-identifiers';
import { COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER } from 'src/constants/object-universal-identifiers';
import { APPLICATION_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

// Valores del SELECT `emailStatus` de Hypothesis (src/objects/commercial-hypothesis.object.ts),
// en su orden. '' es la columna «sin valor» del kanban: las hipótesis sin borrador todavía.
export const HYPOTHESIS_EMAIL_STATUSES = ['DRAFT', 'READY', 'SENDING', 'SENT'] as const;
export const NO_VALUE_GROUP = '';

// Campos de sistema que el motor deriva para el objeto (createdAt / updatedAt): mismo cálculo
// que usa el SDK para los objetos de serie.
export const HYPOTHESIS_SYSTEM_FIELD_IDS = {
  createdAt: getFieldUniversalIdentifier({ applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER, objectUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER, name: 'createdAt' }),
  updatedAt: getFieldUniversalIdentifier({ applicationUniversalIdentifier: APPLICATION_UNIVERSAL_IDENTIFIER, objectUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER, name: 'updatedAt' }),
} as const;

// Tanda 21 — «Hipótesis · Envíos»: kanban de hipótesis por estado del email (borrador, revisado,
// enviándose, enviado) para seguir los primeros contactos. Es solo una vista: no cambia el objeto.
// Los seguimientos de los enviados sin respuesta son tareas «🔔 Seguimiento — <empresa>» (Tasks).
export default defineView({
  universalIdentifier: IDS.view,
  name: 'Hipótesis · Envíos',
  objectUniversalIdentifier: COMMERCIAL_HYPOTHESIS_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.KANBAN,
  icon: 'IconMailCheck',
  position: 2,
  mainGroupByFieldMetadataUniversalIdentifier: F.emailStatus,
  fields: [
    { universalIdentifier: IDS.fieldName, fieldMetadataUniversalIdentifier: F.name, position: 0, isVisible: true, size: 240 },
    { universalIdentifier: IDS.fieldCompany, fieldMetadataUniversalIdentifier: F.company, position: 1, isVisible: true, size: 180 },
    { universalIdentifier: IDS.fieldEmailTo, fieldMetadataUniversalIdentifier: F.emailTo, position: 2, isVisible: true, size: 200 },
    { universalIdentifier: IDS.fieldEmailSubject, fieldMetadataUniversalIdentifier: F.emailSubject, position: 3, isVisible: true, size: 240 },
    { universalIdentifier: IDS.fieldEmailStatus, fieldMetadataUniversalIdentifier: F.emailStatus, position: 4, isVisible: true, size: 120 },
    { universalIdentifier: IDS.fieldStatus, fieldMetadataUniversalIdentifier: F.status, position: 5, isVisible: true, size: 120 },
    { universalIdentifier: IDS.fieldUpdatedAt, fieldMetadataUniversalIdentifier: HYPOTHESIS_SYSTEM_FIELD_IDS.updatedAt, position: 6, isVisible: true, size: 150 },
    { universalIdentifier: IDS.fieldCreatedAt, fieldMetadataUniversalIdentifier: HYPOTHESIS_SYSTEM_FIELD_IDS.createdAt, position: 7, isVisible: true, size: 150 },
  ],
  groups: [
    { universalIdentifier: IDS.groupNoValue, fieldValue: NO_VALUE_GROUP, position: 0, isVisible: true },
    { universalIdentifier: IDS.groupDraft, fieldValue: 'DRAFT', position: 1, isVisible: true },
    { universalIdentifier: IDS.groupReady, fieldValue: 'READY', position: 2, isVisible: true },
    { universalIdentifier: IDS.groupSending, fieldValue: 'SENDING', position: 3, isVisible: true },
    { universalIdentifier: IDS.groupSent, fieldValue: 'SENT', position: 4, isVisible: true },
  ],
});
