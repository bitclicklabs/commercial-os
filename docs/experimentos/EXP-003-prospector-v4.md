# EXP-003 · Prospector v4: citar el dato que sustenta la notoriedad

Primer experimento automático del ciclo de mejora de skills. Lo ejecutó `pnpm experiment:run` de principio a fin (reserva P5, comparación, evaluación y Release Gate); este documento solo resume la decisión y añade la lectura cualitativa. El informe completo, generado por el runner, está en [`EXP-003-auto/informe.md`](EXP-003-auto/informe.md) (y [`informe.json`](EXP-003-auto/informe.json), con todas las decisiones).

| Campo | Valor |
|---|---|
| Fecha | 2026-10-07 |
| Skill | `prospector-event-exhibitors` |
| Baseline | v3 `ACTIVE` · `317ee89f-0bff-4525-83b5-ae49dbe03119` |
| Candidata | v4 `DRAFT` · `537a7deb-2fe7-4bad-be3e-b3dfed0fb43c` · `content_hash` `4ce725064324…` |
| Operaciones | 1 `ADD` sobre v3 (OP7): 0 % del texto base sustituido, 5 % añadido ([`EXP-003-prospector-v4.ops.json`](EXP-003-prospector-v4.ops.json)) |
| Datos | `prospeccion-v1` v1: los 2 casos de `VALIDATION` (sin etiquetar) + 7 de muestra de forma (`TRAIN` sin quemar), × 2 repeticiones × 2 versiones |
| Coste | 0,1433 € de 0,30 € (ejecutor 0,0853 €, juez 0,0580 €) |
| **Decisión del gate** | **FAIL** (modo forma): composite 0,948 → 0,954, Δ 0,007 < 0,02 |
| Estado | v4 **no activada**: el Release Gate la bloquea (`409 release_gate_blocked`); activarla exigiría `force` con motivo, decisión del PM |

## Qué cambia OP7

El juez del EXP-002 (`judge.commercial_relevance@1`) dejó en nivel 2 las dos razones de v3 que superan el techo de confianza por notoriedad (TEMPLO CAFÉS y UNOX): se apoyaban en «conocimiento general» sin decir qué dato lo justifica. OP7 añade tras el techo: «Si superas el techo por notoriedad, cita además en "reason" el dato concreto que la sustenta (…); si no puedes citar ningún dato concreto, no superes el techo». Es un cambio deliberadamente pequeño: su objetivo principal era probar el motor de experimentos de extremo a extremo con datos y modelo reales.

## Resultado del gate

| Criterio | v3 | v4 | Resultado |
|---|---|---|---|
| Composite ≥ baseline + 0,02 | 0,948 | 0,954 | ❌ (Δ 0,007) |
| Fallos duros de la candidata | 0 | 0 | ✅ |
| Seesaw (6 reglas en 1,0 en la baseline) | — | 0 regresiones | ✅ |
| Coste/decisión ≤ ×1,25 | 0,0023 € | 0,0024 € | ✅ (+2,9 %) |
| Accuracy | — | — | no aplica: 0 casos etiquetados (modo forma) |

La única diferencia medible está en `rule.assumptions_marked` (0,667 → 0,750, 1 caso «solo nombre» más que marca la suposición), dentro del ruido de 12 decisiones. Los dos jueces dan lo mismo a las dos versiones (NEXT_ACTION_QUALITY 1,0; COMMERCIAL_RELEVANCE 0,778). Mismos relevantes y escribibles (18/18), misma confianza media (0,63), ninguna incoherencia en descartes. Con la muestra de 9 expositores de Gastrónoma ninguno era un caso de «techo superado con sector», que es exactamente lo que OP7 corrige: el gate no tenía con qué ver la mejora.

## Lectura cualitativa (lo que el gate no ve)

- **El efecto buscado aparece en el único caso de notoriedad.** PRODUCTOS CHURRUCA (solo nombre, 0,85 en las dos versiones): v3 dice «Por conocimiento general, … fabricante líder y consolidado de frutos secos»; v4 cita productos concretos («famosa por sus pipas y maíz tostado…»). En v3 el juez ya le daba nivel 4.
- **Riesgo nuevo: hechos de memoria presentados como comprobados.** La misma razón de v4 termina con «Al basarnos en su notoriedad pública **contrastada**…»: nada se contrastó (no hay dominio ni descripción en la entrada). Y en PROAVA (solo nombre) v4 escribe como hecho «es una entidad privada sin ánimo de lucro…». Pedir «el dato concreto» empuja al modelo a afirmar detalles que no vienen en la entrada, justo lo que OP5 intenta evitar. Si se itera, OP7 debería pedir que el dato se marque como conocimiento general no verificado, y convendría una regla que detecte «contrastad*/verificad*» sin fuente.
- **Ningún cambio en el CRM.** Todos los expositores llegaban sin dominio (`skipped_no_domain`): ni v3 ni v4 habrían escrito en Twenty (0 escrituras también en el FakeTwenty).

## P5

El runner marcó con `markUsed` (`EXP-003`, `validation`) los 2 casos de `VALIDATION` (MisterRestaurant y WATERCUT) y los 7 de la muestra de forma (VERDE DIVINO, ONEKEG, PRODUCTOS CHURRUCA, TPV ÚNICO – KIOSKPOS – NUMIQA, SORBETES Y GRANIZADOS, PROAVA y QUESOS DON EUSEBIO). Quedan quemados: el split `VALIDATION` de `prospeccion-v1` está agotado para otros experimentos. `TEST` (6 casos) no se ha tocado: la decisión preliminar fue FAIL. Los datos de diseño de OP7 (notas del juez del EXP-002 sobre `gastronoma-holdout-2.json`) ya estaban quemados por el registro de exclusiones.

## Siguiente paso (decisión del PM)

1. No activar v4: el gate da FAIL y la lectura cualitativa añade un riesgo. Puede quedarse en `DRAFT` o deprecarse (`POST /skills/prospector-event-exhibitors/versions/4/deprecate`).
1. Para cualquier experimento nuevo de esta skill hace falta material de validación: un `prospeccion-v2` re-cosechado tras nuevas ferias o veredictos del comercial (el `VALIDATION` de v1 ya está gastado).
