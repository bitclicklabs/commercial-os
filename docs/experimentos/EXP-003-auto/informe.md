# EXP-003 · prospector-event-exhibitors v3 vs v4 (experimento automático)

Generado por `pnpm experiment:run` (runner v1). Lo que EXP-001 y EXP-002 hicieron a mano, en una ejecución: reserva de casos con P5, comparación con el proveedor real, evaluación automática y Release Gate (LLD v0.1 §11.5-11.6).

| Campo | Valor |
|---|---|
| Fecha | 2026-10-07 (el agente ve 2026-10-07) |
| Sujeto | skill `prospector-event-exhibitors` |
| Baseline | v3 `ACTIVE` · `317ee89f-0bff-4525-83b5-ae49dbe03119` · `content_hash` `f8078d67b891…` |
| Candidata | v4 `DRAFT` · `537a7deb-2fe7-4bad-be3e-b3dfed0fb43c` · `content_hash` `4ce725064324…` |
| Dataset | `prospeccion-v1` v1 (DRAFT) · `4296000e-c0c4-4be5-b1b4-e4cbb3687af4` |
| Ejecución | gemini-flash-latest, 2 repetición(es) por versión, FakeTwenty (0 escrituras en Twenty) |
| Juez | gemini-pro-latest |
| Coste | 0,1433 € de 0,3000 € (ejecutor 0,0853 € de 0,2000 €; juez 0,0580 € de 0,1000 €) |
| Fases | VALIDATION FAIL · TEST no ejecutado |
| **Decisión** | **FAIL** (modo forma) |

**FAIL: no cumple composite_delta.**

TEST: decisión preliminar FAIL: TEST no se toca.

La activación es una decisión humana (LLD §19): este experimento no activa nada.

```sh
# Si decides activar (el gate la deja pasar solo con PASS o PASS_FORM frente a la versión activa):
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/4/activate" -H 'x-tenant-id: publiexpe'
```

## Fase VALIDATION

Casos: 2 del split VALIDATION (0 etiquetados) + 7 de muestra de forma (TRAIN sin quemar, sin efecto en la accuracy). Coste: ejecutor 0,0853 €, juez 0,0580 €.

### Release Gate (modo forma): **FAIL**

FAIL: no cumple composite_delta.

| Criterio | Baseline | Candidata | Umbral | Resultado | Detalle |
|---|---|---|---|---|---|
| Composite ≥ baseline + 0,02 | 0,948 | 0,954 | 0,968 | ❌ no cumple | Δ = 0,007 (mínimo 0,02) |
| Fallos duros de la candidata ≤ 0 | 0 | 0 | 0 | ✅ cumple | ningún evaluador duro falla y se cumplen los umbrales por dimensión |
| Seesaw: ninguna regla resuelta por la baseline cae | 6 | 0 | 0 | ✅ cumple | 6 regla(s) con 1,0 en la baseline; ninguna cae |
| Coste/decisión ≤ baseline × 1,25 | 0,0023 € | 0,0024 € | 0,0029 € | ✅ cumple | +2,9 % por decisión |
| Accuracy (casos etiquetados) ≥ baseline | — | — | — | — no aplica | modo forma: 0 casos etiquetados en el split; la accuracy no se puede medir |

### Métricas por versión

| Métrica | v3 (baseline) | v4 (candidata) |
|---|---|---|
| **Composite** (veredicto del composite) | **0,948** (PASS) | **0,954** (PASS) |
| TASK_SUCCESS | 1,000 | 1,000 |
| NEXT_ACTION_QUALITY | 1,000 | 1,000 |
| FACTUALITY | 0,889 | 0,917 |
| SOURCE_QUALITY | 1,000 | 1,000 |
| COMMERCIAL_RELEVANCE | 0,778 | 0,778 |
| Sin evaluar (peso redistribuido) | CRM_CORRECTNESS | CRM_CORRECTNESS |
| `rule.decision_valid@1` | 1,000 · 0/18 fallos | 1,000 · 0/18 fallos |
| `rule.need_has_quantities@1` | 1,000 · 0/18 fallos | 1,000 · 0/18 fallos |
| `rule.quantity_spread_le_2_5@1` | 1,000 · 0/18 fallos | 1,000 · 0/18 fallos |
| `rule.budget_derived@1` | 1,000 · 0/18 fallos | 1,000 · 0/18 fallos |
| `rule.assumptions_marked@1` | 0,667 · 4/12 fallos | 0,750 · 3/12 fallos |
| `rule.confidence_capped_by_data@1` | 1,000 · 0/18 fallos | 1,000 · 0/18 fallos |
| `rule.discard_confidence_low@1` (dura) | no aplica | no aplica |
| `rule.source_urls_known@1` (dura) | 1,000 · 0/18 fallos | 1,000 · 0/18 fallos |
| `judge.next_action_quality@1` | 1,000 · 0/9 fallos | 1,000 · 0/9 fallos |
| `judge.commercial_relevance@1` | 0,778 · 0/9 fallos | 0,778 · 0/9 fallos |
| Decisiones (errores) | 18 (0) | 18 (0) |
| Relevantes / escribibles | 18 / 18 | 18 / 18 |
| Confianza media | 0,63 | 0,63 |
| No relevantes con confianza > 0,19 | 0 | 0 |
| Accuracy (casos etiquetados) | — (0 etiquetados) | — (0 etiquetados) |
| Tokens entrada / salida | 34910 / 6053 | 36120 / 6189 |
| Coste ejecutor (por decisión) | 0,0420 € (0,0023 €) | 0,0433 € (0,0024 €) |

### Casos usados (P5)

| Expositor | Split | Uso | Etiqueta | Datos | Caso |
|---|---|---|---|---|---|
| MisterRestaurant | VALIDATION | validation | unlabeled | hard | `f5aacd8b` |
| WATERCUT | VALIDATION | validation | unlabeled | hard | `87f35ae4` |
| VERDE DIVINO | TRAIN | form_sample | unlabeled | medium | `0c2f9c2d` |
| ONEKEG | TRAIN | form_sample | unlabeled | medium | `a8df6e72` |
| PRODUCTOS CHURRUCA, S.A. | TRAIN | form_sample | unlabeled | hard | `720d4a44` |
| TPV ÚNICO – KIOSKPOS – NUMIQA | TRAIN | form_sample | unlabeled | medium | `9af9442f` |
| SORBETES Y GRANIZADOS | TRAIN | form_sample | unlabeled | hard | `b36be110` |
| PROAVA | TRAIN | form_sample | unlabeled | hard | `02acd28f` |
| QUESOS DON EUSEBIO | TRAIN | form_sample | unlabeled | hard | `bc495dbe` |

- `markUsed` validation: 2 marcados, 0 ya estaban, 2 quemados ahora (EXP-003 VALIDATION: v3 vs v4).
- `markUsed` validation: 7 marcados, 0 ya estaban, 7 quemados ahora (EXP-003 muestra de forma (TRAIN sin quemar; el gate no la usa para accuracy)).
- Evaluaciones guardadas en el tenant `experiments`: 38 nuevas, 0 ya existían.

## Anexo A · Comparación lado a lado (skill:compare)

Fase VALIDATION · fixture `EXP-003/validation-1`

#### Comparación v3 vs v4 — `prospector-event-exhibitors`

- Entrada: Gastrónoma 2026, 9 expositores, 2 repetición(es) por versión. Hash de la entrada: `7615c152d334238c`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-07. CRM: FakeTwenty (en memoria).
- Coste total: 0,0853 € de un presupuesto de 0,2000 €.

| Métrica | v3 | v4 |
|---|---|---|
| Decisiones (errores) | 18 (0) | 18 (0) |
| Relevantes | 18 | 18 |
| Escribibles (confianza ≥ umbral) | 18 | 18 |
| Confianza media (todas las decisiones) | 0,63 | 0,63 |
| Confianza media (solo relevantes) | 0,63 | 0,63 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (solo nombre) | 0,60 / 0,85 (n=12) | 0,60 / 0,85 (n=12) |
| Relevantes: confianza media / máx. (nombre + sector) | 0,70 / 0,70 (n=6) | 0,69 / 0,70 (n=6) |
| Hipótesis | 18 | 18 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 560-900 u / 650-1200 € (×1) | 260-500 u / 650-1400 € (×1) |
| Amplitud media cantidad (máx./mín.) | 1,72 | 1,79 |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 18/18 | 18/18 |
| Precio unitario implícito en 0,50-15 € | 18/18 | 18/18 |
| Solo nombre: la razón marca la suposición | 8/12 | 9/12 |
| Tokens de entrada / salida | 34910 / 6053 | 36120 / 6189 |
| Coste (por decisión) | 0,0420 € (0,0023 €) | 0,0433 € (0,0024 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,006 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v3: rel. · conf. | v4: rel. · conf. | Δ conf. | v3: cantidad · presupuesto | v4: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| MisterRestaurant | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,55 | 0,00 | 560-900 u · 650-1250 € | 250-500 u · 550-1200 € |
| WATERCUT | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,55 | 0,00 | 350-600 u · 650-1250 € | 260-450 u · 650-1250 € |
| VERDE DIVINO | sector | 2/2 · 0,70 / 0,70 | 2/2 · 0,70 / 0,70 | 0,00 | 408-800 u · 950-1950 € | 460-750 u · 850-1650 € |
| ONEKEG | sector | 2/2 · 0,70 / 0,70 | 2/2 · 0,65 / 0,70 | -0,03 | 610-900 u · 950-1600 € | 350-650 u · 750-1500 € |
| PRODUCTOS CHURRUCA, S.A. | name_only | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 1520-2500 u · 2400-4500 € | 1000-2000 u · 1800-3500 € |
| TPV ÚNICO – KIOSKPOS – NUMIQA | sector | 2/2 · 0,70 / 0,70 | 2/2 · 0,70 / 0,70 | 0,00 | 350-550 u · 650-1250 € | 510-1000 u · 850-1800 € |
| SORBETES Y GRANIZADOS | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,55 | 0,00 | 258-500 u · 450-950 € | 550-800 u · 850-1600 € |
| PROAVA | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,60 | 0,03 | 715-1200 u · 1400-2500 € | 700-1000 u · 1200-2200 € |
| QUESOS DON EUSEBIO | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,55 | 0,00 | 360-600 u · 850-1800 € | 500-800 u · 650-1250 € |

#### Necesidad y razón (última repetición válida)

- **MisterRestaurant** (name_only)
  - v3 · razón: Por el nombre, parece una empresa de servicios, software o suministros para hostelería exponiendo en feria del sector. Solo contamos con el nombre sin web ni descripción, por lo que asumimos presencia en stand pequeño o mediano.
  - v3 · need: Unas 250 bolsas de tela para entregar información comercial en el stand, 300 bolígrafos grabados y 10 delantales o polos personalizados para el personal. · productos: bolsas tote de algodón personalizadas, bolígrafos metálicos grabados, delantales bordados para hostelería, lanyards personalizados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v4 · razón: Por el nombre, parece una empresa de servicios, software o suministros para restauración presente en Gastrónoma; no tenemos datos adicionales, por lo que asumimos un stand de tamaño estándar y limitamos la confianza al techo de 0,6.
  - v4 · need: Unas 250 libretas con bolígrafo para hosteleros que visiten el stand y 8 delantales o polos bordados para el personal comercial. · productos: Libretas personalizadas, Bolígrafos promocionales, Delantales de cocina bordados, Polos corporativos, Bolsas de algodón (tote bags) · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **WATERCUT** (name_only)
  - v3 · razón: Empresa privada que expone en Gastrónoma 2026; por su nombre parece especializada en corte por agua o maquinaria para hostelería/alimentación. Al disponer únicamente del nombre comercial, la estimación de necesidades se ajusta a un stand estándar.
  - v3 · need: Unas 250 bolsas de tela serigrafiadas y 300 bolígrafos para entregar a visitantes, además de unos 10 polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Bolígrafos metálicos grabados, Polos técnicos bordados, Lanyards corporativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v4 · razón: Por el nombre y su presencia en Gastrónoma parece una empresa de corte por chorro de agua o maquinaria/equipamiento para pastelería y hostelería; al no tener descripción detallada, se asume un stand mediano y se mantiene la confianza topada en 0,6.
  - v4 · need: Unas 250 bolsas de tela para entregar catálogos técnicos a visitantes y 10 polos bordados para el personal técnico y comercial del stand. · productos: bolsas tote de algodón personalizadas, polos bordados, libretas personalizadas, bolígrafos metálicos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **VERDE DIVINO** (sector)
  - v3 · razón: Empresa privada del sector del aceite exponiendo en Gastrónoma 2026. Al disponer solo de nombre y sector, se asume un stand de tamaño pequeño a mediano con necesidad de material promocional gourmet.
  - v3 · need: Unas 250 bolsas tote de algodón de calidad para entregar muestras/botellas a distribuidores, 150 libretas con bolígrafo para notas de cata y 8 delantales bordados para el personal del stand. · productos: bolsas tote de algodón personalizadas, delantales bordados, libretas con bolígrafo, lanyards personalizados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v4 · razón: Empresa privada del sector oleícola exponiendo en Gastrónoma 2026. Al disponer solo de nombre y sector, se calcula el potencial para un stand de tamaño medio, aplicando el techo correspondiente de confianza.
  - v4 · need: Unas 250 bolsas de tela o yute para botellas y muestras, 200 libretas con bolígrafo para contactos comerciales y 10 delantales o polos bordados para el personal del stand. · productos: Bolsas de algodón y yute para botellas, Delantales bordados para catas, Libretas y bolígrafos ecológicos, Lanyards corporativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **ONEKEG** (sector)
  - v3 · razón: Empresa privada del sector de bebidas y equipamiento para hostelería con presencia confirmada en feria. Al contar solo con nombre y sectores categorizados, se asume un stand de tamaño medio para el cálculo de cantidades.
  - v3 · need: Unas 300 bolsas de tela o non-woven para entregar catálogos y muestras a profesionales del canal HORECA, 300 abridores/sacacorchos personalizados y 10 delantales o polos bordados para el equipo del stand. · productos: Bolsas tote de algodón o non-woven, Sacacorchos y abridores multiusos personalizados, Polos o delantales bordados para el personal, Lanyards corporativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v4 · razón: Empresa privada expositora vinculada a bebidas y equipamiento hostelero en Gastrónoma 2026. Al disponer solo de nombre y sectores, se asume un stand mediano sin superar el techo de confianza.
  - v4 · need: Unas 300 bolsas de tela para catas y presentaciones de producto, 250 abridores o sacacorchos grabados y 10 polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Sacacorchos y abridores grabados, Polos bordados, Lanyards personalizados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **PRODUCTOS CHURRUCA, S.A.** (name_only)
  - v3 · razón: Por conocimiento general, Productos Churruca es un fabricante líder y consolidado de frutos secos y aperitivos, con stand habitual y alto flujo de visitantes en ferias del sector agroalimentario.
  - v3 · need: Unas 1.000 bolsas tote para entregar muestras de producto a visitantes, 500 libretas con bolígrafo para citas con distribuidores y 20 polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Polos técnicos bordados, Bolígrafos metálicos grabados, Libretas de notas tamaño A5, Lanyards con portacredencial · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v4 · razón: Empresa referente y ampliamente conocida a nivel nacional en aperitivos y frutos secos (famosa por sus pipas y maíz tostado 'kikos'), con sede en Valencia y gran potencial comercial. Al basarnos en su notoriedad pública contrastada, elevamos la confianza por encima del techo estándar.
  - v4 · need: Unas 1.000 bolsas de tela o mochilas de cuerdas para entregar muestras de producto a visitantes profesionales, 500 bolígrafos y 20 polos bordados corporativos para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Mochilas de cuerdas, Polos bordados, Bolígrafos promocionales, Lanyards corporativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **TPV ÚNICO – KIOSKPOS – NUMIQA** (sector)
  - v3 · razón: Empresa privada de software y soluciones TPV/kioscos para hostelería exponiendo en feria gastronómica. Al disponer únicamente de nombre y sector, se dimensiona para un stand mediano estándar.
  - v3 · need: Unas 250 libretas con bolígrafo para demostraciones comerciales a hosteleros, 200 lanyards con identificador y 10 polos técnicos bordados para el personal del stand. · productos: Libretas personalizadas con bolígrafo, Lanyards corporativos, Polos técnicos bordados, Memorias USB con catálogo o demo de software · IMMEDIATE · TALLER_PROPIO, PRECIO, TRATO_CERCANO
  - v4 · razón: Empresa privada proveedora de soluciones de software y TPV para hostelería con encaje directo para promocionar sus soluciones en Gastrónoma. Al contar solo con nombre y sector sin datos de tamaño, se asume un stand de dimensiones estándar.
  - v4 · need: Unas 300 libretas con bolígrafo para demostraciones a hosteleros, 200 lanyards con soporte y 10 polos técnicos bordados para el equipo comercial del stand. · productos: Libretas personalizadas con bolígrafo, Lanyards personalizados, Polos bordados para personal, Memorias USB con catálogo de software · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **SORBETES Y GRANIZADOS** (name_only)
  - v3 · razón: Por el nombre, parece una empresa de elaboración o distribución de bebidas/postres para hostelería; al no tener datos de tamaño ni web, estimamos un stand pequeño.
  - v3 · need: Unas 250 bolsas de tela o non-woven para entregar a visitantes con folletos y muestras, además de 8 delantales o camisetas serigrafiadas para el personal que sirve degustaciones. · productos: Bolsas de non-woven personalizadas, Delantales de cocina serigrafiados, Camisetas de algodón con logo, Vasos reutilizables personalizados · IMMEDIATE · TALLER_PROPIO, PRECIO, TRATO_CERCANO
  - v4 · razón: Por el nombre, parece una empresa del sector de bebidas y hostelería que expone en Gastrónoma; al tener solo el nombre comercial, asumimos un stand pequeño y limitamos la confianza.
  - v4 · need: Unas 250 bolsas tote de algodón y 300 vasos o bidones reutilizables para visitantes y catas, además de 6 delantales o polos bordados para el equipo del stand. · productos: Vasos reutilizables personalizados, Bolsas tote de algodón, Delantales personalizados, Polos bordados, Servilletas o posavasos personalizados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **PROAVA** (name_only)
  - v3 · razón: Por conocimiento general, PROAVA es una entidad/asociación valenciana dedicada a la promoción agroalimentaria de calidad, por lo que suele requerir merchandising para degustaciones y difusión, aunque solo disponemos del nombre.
  - v3 · need: Unas 400 bolsas tote para entrega de información y muestras, 300 copas o catavinos serigrafiados para degustaciones y 15 delantales bordados para el personal. · productos: Bolsas tote de algodón personalizadas, Copas o catavinos serigrafiados, Delantales bordados, Bolígrafos personalizados, Lanyards · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
  - v4 · razón: PROAVA (Promoción Agroalimentaria de Calidad de la Comunitat Valenciana) es una entidad privada sin ánimo de lucro conocida en el sector agroalimentario valenciano que suele dinamizar stands y catas. Al contar únicamente con el nombre, nos basamos en conocimiento general del sector agroalimentario local y limitamos la confianza al techo correspondiente.
  - v4 · need: Unas 400 copas o catavinos serigrafiados para degustaciones, 300 bolsas de tela para folletos institucionales y 15 delantales bordados para el personal del stand. · productos: Copas de cata serigrafiadas, Bolsas tote de algodón personalizadas, Delantales bordados, Lanyards e identificadores · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **QUESOS DON EUSEBIO** (name_only)
  - v3 · razón: Por el nombre, parece una quesería o productor agroalimentario tradicional que expone en Gastrónoma; calculamos para un stand pequeño o mediano al no tener más datos de la empresa.
  - v3 · need: Unas 250 bolsas de tela o algodón para entregar catálogos y muestras a distribuidores, 10 delantales o polos bordados para el personal del stand y 100 tablas de cortar o cuchillos queseros promocionales como detalle para clientes clave. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina bordados, Polos técnicos bordados, Tablas de madera personalizadas con láser · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v4 · razón: Por el nombre, parece una quesería o productor agroalimentario que expone en Gastrónoma 2026. Al disponer solo del nombre, calculamos necesidades para un stand pequeño o mediano y aplicamos el techo de confianza.
  - v4 · need: Unos 250 delantales o bolsas de tela para clientes y degustaciones, 500 bolsas de papel o tela para venta directa y 6 delantales o polos bordados para el equipo del stand. · productos: bolsas tote de algodón personalizadas, delantales personalizados, polos bordados, bolígrafos promocionales · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO

## Anexo B · Evaluación automática

#### Evaluación · EXP-003 · VALIDATION

- Generado: 2026-10-07T15:56:30.798Z. Composite: `composite.commercial_score@1` (`372504cd576e`).
- Juez: gemini-pro-latest · 2 llamadas · 0,0580 € de 0,10 € · 0 casos sin nota del juez.

| | v3 | v4 |
|---|---|---|
| **Veredicto** | **PASS** | **PASS** |
| **Score compuesto** | **0,948** | **0,954** |
| Restricciones duras incumplidas | ninguna | ninguna |
| Casos | 18 | 18 |
| TASK_SUCCESS (peso efectivo) | 1,000 (0,353) | 1,000 (0,353) |
| NEXT_ACTION_QUALITY (peso efectivo) | 1,000 (0,118) | 1,000 (0,118) |
| FACTUALITY (peso efectivo) | 0,889 (0,235) | 0,917 (0,235) |
| SOURCE_QUALITY (peso efectivo) | 1,000 (0,177) | 1,000 (0,177) |
| COMMERCIAL_RELEVANCE (peso efectivo) | 0,778 (0,118) | 0,778 (0,118) |
| Sin evaluar (peso redistribuido) | CRM_CORRECTNESS | CRM_CORRECTNESS |

##### Por evaluador

| Evaluador | Tipo | Dimensión | Dura | v3: score · fallos/aplicables | v4: score · fallos/aplicables |
|---|---|---|---|---|---|
| `rule.decision_valid@1` | RULE | TASK_SUCCESS | no | 1,000 · 0/18 | 1,000 · 0/18 |
| `rule.need_has_quantities@1` | RULE | NEXT_ACTION_QUALITY | no | 1,000 · 0/18 | 1,000 · 0/18 |
| `rule.quantity_spread_le_2_5@1` | RULE | NEXT_ACTION_QUALITY | no | 1,000 · 0/18 | 1,000 · 0/18 |
| `rule.budget_derived@1` | RULE | FACTUALITY | no | 1,000 · 0/18 | 1,000 · 0/18 |
| `rule.assumptions_marked@1` | RULE | FACTUALITY | no | 0,667 · 4/12 | 0,750 · 3/12 |
| `rule.confidence_capped_by_data@1` | RULE | FACTUALITY | no | 1,000 · 0/18 | 1,000 · 0/18 |
| `rule.discard_confidence_low@1` | RULE | COMMERCIAL_RELEVANCE | sí | — (no aplica) | — (no aplica) |
| `rule.source_urls_known@1` | RULE | SOURCE_QUALITY | sí | 1,000 · 0/18 | 1,000 · 0/18 |
| `judge.next_action_quality@1` | LLM_JUDGE | NEXT_ACTION_QUALITY | no | 1,000 · 0/9 | 1,000 · 0/9 |
| `judge.commercial_relevance@1` | LLM_JUDGE | COMMERCIAL_RELEVANCE | no | 0,778 · 0/9 | 0,778 · 0/9 |

##### Por sujeto

| Sujeto | Veredicto | Score | Duras incumplidas |
|---|---|---|---|
| v3 · validation-1 · r1 | PASS | 0,948 | — |
| v4 · validation-1 · r1 | PASS | 0,961 | — |
| v4 · validation-1 · r2 | PASS | 0,970 | — |
| v3 · validation-1 · r2 | PASS | 0,970 | — |

##### Notas del juez

| Sujeto | Caso | Dimensión | Nivel | Justificación | Cita |
|---|---|---|---|---|---|
| v3 · validation-1 · r1 | MisterRestaurant | NEXT_ACTION_QUALITY | 4 | Detalla unidades por producto, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Listo para presupuestar. | «Unas 250 bolsas tote de tela y 300 bolígrafos» |
| v3 · validation-1 · r1 | WATERCUT | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 200 libretas con bolígrafo para repartir entre clientes» |
| v3 · validation-1 · r1 | VERDE DIVINO | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto adecuado, plazo ligado al evento y diferencial de taller propio. El comercial tiene todo para presupuestar. | «Unas 200 bolsas de algodón para catas y muestras» |
| v3 · validation-1 · r1 | ONEKEG | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 300 bolsas tote para entregar catálogos a profesionales» |
| v3 · validation-1 · r1 | PRODUCTOS CHURRUCA, S.A. | NEXT_ACTION_QUALITY | 4 | Desglosa unidades por producto, el presupuesto es coherente, el plazo está ligado al evento y menciona el taller propio. El comercial puede presupuestar directamente. | «Unas 500 bolsas de tela o non-woven para entregar» |
| v3 · validation-1 · r1 | TPV ÚNICO – KIOSKPOS – NUMIQA | NEXT_ACTION_QUALITY | 4 | Ofrece un desglose claro de unidades, presupuesto coherente, motivo ligado al evento y diferencial pertinente (taller propio). Totalmente accionable para presupuestar. | «Unas 250 libretas con bolígrafo para demostraciones comerciales» |
| v3 · validation-1 · r1 | SORBETES Y GRANIZADOS | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. El comercial puede presupuestar ya. | «Unas 200 bolsas de tela o vasos reutilizables» |
| v3 · validation-1 · r1 | PROAVA | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 400 copas de cata grabadas a láser» |
| v3 · validation-1 · r1 | QUESOS DON EUSEBIO | NEXT_ACTION_QUALITY | 4 | La hipótesis detalla unidades por producto, un presupuesto coherente, un motivo claro ligado al evento inminente y destaca el taller propio como diferencial. Totalmente accionable. | «Unas 250 bolsas tote de algodón para compras o catas» |
| v3 · validation-1 · r1 | MisterRestaurant | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand mediano. | «al no tener descripción ni web la confianza se limita y se asume un stand mediano» |
| v3 · validation-1 · r1 | WATERCUT | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand estándar. | «solo disponemos del nombre comercial sin descripción ni web, por lo que asumimos un stand estándar» |
| v3 · validation-1 · r1 | VERDE DIVINO | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.7) es coherente con tener nombre y sector, asumiendo un stand mediano. | «Al disponer solo de nombre y sector, se asume un stand mediano típico del sector gourmet» |
| v3 · validation-1 · r1 | ONEKEG | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.7) es coherente con tener nombre y sector, asumiendo un stand mediano. | «Al disponer de nombre y sectores pero sin datos de tamaño, calculamos para un stand mediano» |
| v3 · validation-1 · r1 | PRODUCTOS CHURRUCA, S.A. | COMMERCIAL_RELEVANCE | 4 | El encaje es claro y específico, basado en conocimiento general de la empresa que justifica superar el techo de confianza por falta de datos. | «Me baso en conocimiento general del mercado para superar el techo por falta de descripción» |
| v3 · validation-1 · r1 | TPV ÚNICO – KIOSKPOS – NUMIQA | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.7) es coherente con tener nombre y sector, asumiendo un stand mediano. | «disponemos solo de nombre y sector, por lo que estimamos un stand mediano» |
| v3 · validation-1 · r1 | SORBETES Y GRANIZADOS | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand pequeño. | «al no tener web ni descripción se calculan necesidades de stand pequeño» |
| v3 · validation-1 · r1 | PROAVA | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand asociativo medio. | «Solo disponemos del nombre en los datos recibidos, por lo que estimamos un stand asociativo» |
| v3 · validation-1 · r1 | QUESOS DON EUSEBIO | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand pequeño o mediano. | «Solo disponemos del nombre, por lo que asumimos un stand de tamaño pequeño o mediano» |
| v4 · validation-1 · r1 | MisterRestaurant | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. El comercial puede presupuestar ya. | «Unas 250 bolsas tote de algodón para repartir catálogos» |
| v4 · validation-1 · r1 | WATERCUT | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 250 bolsas de tela para entregar catálogos técnicos» |
| v4 · validation-1 · r1 | VERDE DIVINO | NEXT_ACTION_QUALITY | 4 | Detalla unidades por producto, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Listo para presupuestar. | «Unas 300 bolsas de tela o yute para entregar muestras» |
| v4 · validation-1 · r1 | ONEKEG | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 250 bolsas tote de algodón para catálogos y muestras» |
| v4 · validation-1 · r1 | PRODUCTOS CHURRUCA, S.A. | NEXT_ACTION_QUALITY | 4 | Detalla unidades por producto, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Listo para presupuestar. | «Unas 1.000 bolsas de tela personalizadas para muestras» |
| v4 · validation-1 · r1 | TPV ÚNICO – KIOSKPOS – NUMIQA | NEXT_ACTION_QUALITY | 4 | Detalla unidades por producto, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Listo para presupuestar. | «Unas 250 libretas y bolígrafos para demostraciones de software» |
| v4 · validation-1 · r1 | SORBETES Y GRANIZADOS | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 250 bolsas de tela o vasos reutilizables personalizados» |
| v4 · validation-1 · r1 | PROAVA | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas, presupuesto coherente, plazo ligado al evento y diferencial de taller propio. El comercial puede presupuestar ya. | «Unas 400 copas de cata serigrafiadas con estuche» |
| v4 · validation-1 · r1 | QUESOS DON EUSEBIO | NEXT_ACTION_QUALITY | 4 | Desglose de unidades, presupuesto coherente, plazo claro ligado al evento y diferencial de taller propio. Totalmente accionable. | «Unas 200 bolsas tote de tela o algodón para entregar» |
| v4 · validation-1 · r1 | MisterRestaurant | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand estándar. | «al no tener descripción ni web se calcula para un stand estándar y la confianza no supera 0,6» |
| v4 · validation-1 · r1 | WATERCUT | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand estándar. | «Al disponer solo del nombre, la confianza se limita a 0,55 y se asume un stand estándar» |
| v4 · validation-1 · r1 | VERDE DIVINO | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.7) es coherente con tener nombre y sector, asumiendo un stand mediano. | «Al contar únicamente con nombre y sector, se calcula la estimación para un stand mediano» |
| v4 · validation-1 · r1 | ONEKEG | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.65) es coherente con tener nombre y sector, asumiendo un stand medio. | «Al disponer solo de nombre y sectores, se asume un stand de tamaño medio» |
| v4 · validation-1 · r1 | PRODUCTOS CHURRUCA, S.A. | COMMERCIAL_RELEVANCE | 4 | El encaje es claro y específico, basado en conocimiento general de la empresa que justifica superar el techo de confianza por falta de datos. | «Superamos el techo de datos por conocimiento general de su sólida posición de mercado» |
| v4 · validation-1 · r1 | TPV ÚNICO – KIOSKPOS – NUMIQA | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.7) es coherente con tener nombre y sector, asumiendo un stand mediano. | «Al disponer de nombre y sector pero no de datos de tamaño, se asume un stand mediano» |
| v4 · validation-1 · r1 | SORBETES Y GRANIZADOS | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand pequeño/medio. | «al tener solo el nombre, asumimos un stand de tamaño pequeño/medio y limitamos la confianza» |
| v4 · validation-1 · r1 | PROAVA | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand asociativo. | «Al contar solo con el nombre en los datos recibidos, mantengo la confianza en un nivel moderado» |
| v4 · validation-1 · r1 | QUESOS DON EUSEBIO | COMMERCIAL_RELEVANCE | 3 | El encaje es razonado y ligado al evento. La confianza (0.55) es coherente con tener solo el nombre, asumiendo un stand pequeño o mediano. | «Al disponer solo del nombre, aplicamos el techo de confianza y estimamos necesidades para un stand pequeño» |

##### Llamadas al juez

| Evaluador | Grupo | Modelo servido | Casos | Intentos | Tokens entrada / salida | Coste |
|---|---|---|---|---|---|---|
| `judge.next_action_quality@1` | v3+v4 | gemini-3.1-pro-preview | 18 | 1 | 7501 / 1470 | 0,0281 € |
| `judge.commercial_relevance@1` | v3+v4 | gemini-3.1-pro-preview | 18 | 1 | 7495 / 1648 | 0,0299 € |

