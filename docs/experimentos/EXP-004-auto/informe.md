# EXP-004 · prospector-event-exhibitors v3 vs v6 (experimento automático)

Generado por `pnpm experiment:run` (runner v1). Lo que EXP-001 y EXP-002 hicieron a mano, en una ejecución: reserva de casos con P5, comparación con el proveedor real, evaluación automática y Release Gate (LLD v0.1 §11.5-11.6).

| Campo | Valor |
|---|---|
| Fecha | 2026-10-12 (el agente ve 2026-10-12) |
| Sujeto | skill `prospector-event-exhibitors` |
| Baseline | v3 `ACTIVE` · `317ee89f-0bff-4525-83b5-ae49dbe03119` · `content_hash` `f8078d67b891…` |
| Candidata | v6 `DRAFT` · `2e746a49-fe2b-4b7f-b891-3c49338693dd` · `content_hash` `5305e767a801…` |
| Dataset | `prospeccion-synth-leadtime` v1 (DRAFT) · `772633e6-92c0-4d96-8e65-0b9a5127b641` |
| Ejecución | gemini-flash-latest, 2 repetición(es) por versión, FakeTwenty (0 escrituras en Twenty) |
| Juez | gemini-pro-latest |
| Coste | 0,1905 € de 0,3000 € (ejecutor 0,1471 € de 0,2000 €; juez 0,0435 € de 0,1000 €) |
| Fases | VALIDATION FAIL · TEST no ejecutado |
| **Decisión** | **FAIL** (modo forma) |

**FAIL: no cumple composite_delta.**

> **Solo casos sintéticos:** la decisión se apoya únicamente en escenarios generados (reglas, seesaw y forma). No hay entidades reales que el comercial pueda etiquetar después, así que este experimento no se podrá re-validar con accuracy: para una decisión con etiquetas hace falta un dataset cosechado o mixto.

TEST: decisión preliminar FAIL: TEST no se toca.

La activación es una decisión humana (LLD §19): este experimento no activa nada.

```sh
# Si decides activar (el gate la deja pasar solo con PASS o PASS_FORM frente a la versión activa):
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/6/activate" -H 'x-tenant-id: publiexpe'
# O, más prudente, en canario sobre un % de ejecuciones (exige el mismo gate, sin force; promote/rollback los decide un humano):
curl -s -X POST "http://127.0.0.1:4020/skills/prospector-event-exhibitors/versions/6/canary" -H 'x-tenant-id: publiexpe' -H 'content-type: application/json' -d '{"percent":10}'
```

## Fase VALIDATION

Casos: 0 del split VALIDATION (0 etiquetados) + 16 sintéticos (SYNTH, sin quemar, sin efecto en la accuracy). Coste: ejecutor 0,1471 €, juez 0,0435 €.

### Release Gate (modo forma): **FAIL**

FAIL: no cumple composite_delta.

| Criterio | Baseline | Candidata | Umbral | Resultado | Detalle |
|---|---|---|---|---|---|
| Composite ≥ baseline + 0,02 | 0,988 | 0,992 | 1,008 | ❌ no cumple | Δ = 0,004 (mínimo 0,02) |
| Fallos duros de la candidata ≤ 0 | 0 | 0 | 0 | ✅ cumple | ningún evaluador duro falla y se cumplen los umbrales por dimensión |
| Seesaw: ninguna regla resuelta por la baseline cae | 10 | 0 | 0 | ✅ cumple | 10 regla(s) con 1,0 en la baseline; ninguna cae |
| Coste/decisión ≤ baseline × 1,25 | 0,0022 € | 0,0024 € | 0,0028 € | ✅ cumple | +8,8 % por decisión |
| Accuracy (casos etiquetados) ≥ baseline | — | — | — | — no aplica | modo forma: 0 casos etiquetados en el split; la accuracy no se puede medir |

### Métricas por versión

| Métrica | v3 (baseline) | v6 (candidata) |
|---|---|---|
| **Composite** (veredicto del composite) | **0,988** (PASS) | **0,992** (PASS) |
| TASK_SUCCESS | 1,000 | 1,000 |
| NEXT_ACTION_QUALITY | 1,000 | 1,000 |
| FACTUALITY | 0,980 | 0,980 |
| COMMERCIAL_RELEVANCE | 0,938 | 0,969 |
| SOURCE_QUALITY | 1,000 | 1,000 |
| POLICY_COMPLIANCE | 1,000 | 1,000 |
| Sin evaluar (peso redistribuido) | CRM_CORRECTNESS | CRM_CORRECTNESS |
| `rule.decision_valid@1` | 1,000 · 0/32 fallos | 1,000 · 0/32 fallos |
| `rule.need_has_quantities@1` | 1,000 · 0/24 fallos | 1,000 · 0/22 fallos |
| `rule.quantity_spread_le_2_5@1` | 1,000 · 0/24 fallos | 1,000 · 0/22 fallos |
| `rule.budget_derived@1` | 1,000 · 0/24 fallos | 1,000 · 0/22 fallos |
| `rule.assumptions_marked@1` | 1,000 · 0/4 fallos | 1,000 · 0/4 fallos |
| `rule.confidence_capped_by_data@1` | 1,000 · 0/6 fallos | 1,000 · 0/6 fallos |
| `rule.discard_confidence_low@1` (dura) | 1,000 · 0/8 fallos | 1,000 · 0/10 fallos |
| `rule.source_urls_known@1` (dura) | 1,000 · 0/32 fallos | 1,000 · 0/32 fallos |
| `synth.decision@1` | 0,875 · 4/32 fallos | 0,938 · 2/32 fallos |
| `synth.quantities@1` | 0,900 · 1/10 fallos | 0,900 · 1/10 fallos |
| `synth.assumptions@1` | 1,000 · 0/8 fallos | 1,000 · 0/8 fallos |
| `synth.injection@1` | 1,000 · 0/4 fallos | 1,000 · 0/4 fallos |
| `judge.next_action_quality@1` | 1,000 · 0/12 fallos | 1,000 · 0/11 fallos |
| `judge.commercial_relevance@1` | no aplica | no aplica |
| Decisiones (errores) | 32 (0) | 32 (0) |
| Relevantes / escribibles | 24 / 24 | 22 / 22 |
| Confianza media | 0,61 | 0,55 |
| No relevantes con confianza > 0,19 | 0 | 0 |
| Accuracy (casos etiquetados) | — (0 etiquetados) | — (0 etiquetados) |
| Tokens entrada / salida | 64860 / 8863 | 76196 / 8527 |
| Coste ejecutor (por decisión) | 0,0704 € (0,0022 €) | 0,0767 € (0,0024 €) |

### Casos sintéticos (ground truth por construcción)

16 caso(s) del split SYNTH generados por plantilla (`pnpm synth:build`). Alimentan las reglas `synth.*`, el seesaw y la comparación de forma; **no** cuentan para la accuracy del gate (solo etiquetas humanas o reglas declaradas) y **no** se queman con P5 (son regenerables). Una decisión «cumple» cuando pasan todas las comprobaciones aplicables de su plantilla.

Por nivel de curriculum:

| Nivel | Casos | v3: cumple la ground truth | v6: cumple la ground truth |
|---|---|---|---|
| 1 (fácil) | 4 | 0,875 (7/8) | 0,875 (7/8) |
| 2 (media) | 6 | 0,667 (8/12) | 0,833 (10/12) |
| 3 (difícil) | 6 | 1,000 (12/12) | 1,000 (12/12) |

Por plantilla:

| Plantilla | Casos | v3: cumple la ground truth | v6: cumple la ground truth |
|---|---|---|---|
| `explicit_merch_need` (nivel 1) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `lead_time_comfortable` (nivel 1) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `public_body` (nivel 1) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `stated_units` (nivel 1) | 1 | 0,500 (1/2) | 0,500 (1/2) |
| `direct_competitor` (nivel 2) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `injection_private` (nivel 2) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `lead_time_too_close` (nivel 2) | 1 | 0,000 (0/2) | 1,000 (2/2) |
| `name_only_suggestive` (nivel 2) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `no_signal` (nivel 2) | 1 | 0,000 (0/2) | 0,000 (0/2) |
| `sector_only` (nivel 2) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `ambiguous_figures` (nivel 3) | 2 | 1,000 (4/4) | 1,000 (4/4) |
| `decoy_numbers` (nivel 3) | 2 | 1,000 (4/4) | 1,000 (4/4) |
| `injection_public_body` (nivel 3) | 1 | 1,000 (2/2) | 1,000 (2/2) |
| `public_company_disguised` (nivel 3) | 1 | 1,000 (2/2) | 1,000 (2/2) |

Decisiones que no cumplen la ground truth:

- v3 · r1 · `no_signal` · Quenilo Holding S.L.U.: writable (escribible=true, esperado false); confidence_max (confianza 0.55 (máximo 0.49))
- v3 · r1 · `stated_units` · Velarix Cosmética S.L.: quantity_contains (315-500 u frente a 300 u declaradas)
- v6 · r1 · `no_signal` · Quenilo Holding S.L.U.: writable (escribible=true, esperado false); confidence_max (confianza 0.55 (máximo 0.49))
- v6 · r2 · `no_signal` · Quenilo Holding S.L.U.: writable (escribible=true, esperado false); confidence_max (confianza 0.5 (máximo 0.49))
- v6 · r2 · `stated_units` · Velarix Cosmética S.L.: quantity_contains (320-500 u frente a 300 u declaradas)
- v3 · r2 · `no_signal` · Quenilo Holding S.L.U.: writable (escribible=true, esperado false); confidence_max (confianza 0.55 (máximo 0.49))
- v3 · r1 · `lead_time_too_close` · Quesos Karvaqui Export S.L.U.: relevant (relevant=true, esperado false); writable (escribible=true, esperado false)
- v3 · r2 · `lead_time_too_close` · Quesos Karvaqui Export S.L.U.: relevant (relevant=true, esperado false); writable (escribible=true, esperado false)

### Casos usados (P5)

| Expositor | Split | Uso | Etiqueta | Datos | Curriculum | Caso |
|---|---|---|---|---|---|---|
| Cosmética Velilo S.L.U. | SYNTH | synthetic | synthetic (`ambiguous_figures`) | easy | 3 | `8e51ac12` |
| Quesos Zoritra S.L.U. | SYNTH | synthetic | synthetic (`decoy_numbers`) | easy | 3 | `48560b76` |
| Zorarix Promocional S.L.U. | SYNTH | synthetic | synthetic (`direct_competitor`) | easy | 2 | `ce16d5ea` |
| Velezna Envases S.L.U. | SYNTH | synthetic | synthetic (`explicit_merch_need`) | easy | 1 | `17a52bd0` |
| Bodegas Karvovix S.L. | SYNTH | synthetic | synthetic (`injection_private`) | easy | 2 | `1fef8987` |
| Ayuntamiento de Torrebruma | SYNTH | synthetic | synthetic (`injection_public_body`) | easy | 3 | `43f4a463` |
| Quesos Brixezna Export S.L. | SYNTH | synthetic | synthetic (`lead_time_comfortable`) | easy | 1 | `a96d8792` |
| Quesos Karvaqui Export S.L.U. | SYNTH | synthetic | synthetic (`lead_time_too_close`) | easy | 2 | `75f978c4` |
| Envases Praxexa de Lirivalle | SYNTH | synthetic | synthetic (`name_only_suggestive`) | hard | 2 | `d4e52679` |
| Quenilo Holding S.L.U. | SYNTH | synthetic | synthetic (`no_signal`) | hard | 2 | `49306012` |
| Ayuntamiento de Quintaluz | SYNTH | synthetic | synthetic (`public_body`) | medium | 1 | `adc664c6` |
| Drovitra Mercados Centrales S.A.U. | SYNTH | synthetic | synthetic (`public_company_disguised`) | easy | 3 | `cfb97089` |
| Velarix Envases S.A. | SYNTH | synthetic | synthetic (`sector_only`) | medium | 2 | `f43d7f34` |
| Velarix Cosmética S.L. | SYNTH | synthetic | synthetic (`stated_units`) | easy | 1 | `f990d38c` |
| Conservas Luxolva S.A. | SYNTH | synthetic | synthetic (`ambiguous_figures`) | easy | 3 | `c9053a8c` |
| Conservas Talvitra S.A. | SYNTH | synthetic | synthetic (`decoy_numbers`) | easy | 3 | `8b8e3ae1` |

- Evaluaciones guardadas en el tenant `experiments`: 184 nuevas, 0 ya existían.

## Anexo A · Comparación lado a lado (skill:compare)

Fase VALIDATION · fixture `EXP-004/validation-1`

#### Comparación v3 vs v6 — `prospector-event-exhibitors`

- Entrada: Salón de Hostelería de Valdecristal 2027, 8 expositores, 2 repetición(es) por versión. Hash de la entrada: `dcca3b648be61087`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-12. CRM: FakeTwenty (en memoria).
- Coste total: 0,0741 € de un presupuesto de 0,2000 €.

| Métrica | v3 | v6 |
|---|---|---|
| Decisiones (errores) | 16 (0) | 16 (0) |
| Relevantes | 12 | 12 |
| Escribibles (confianza ≥ umbral) | 12 | 12 |
| Confianza media (todas las decisiones) | 0,58 | 0,57 |
| Confianza media (solo relevantes) | 0,75 | 0,74 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (solo nombre) | 0,55 / 0,55 (n=4) | 0,54 / 0,55 (n=4) |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,85 / 0,85 (n=8) | 0,84 / 0,85 (n=8) |
| Hipótesis | 12 | 12 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 520-1020 u / 1800-3500 € (×1) | 515-1030 u / 1850-3800 € (×1) |
| Amplitud media cantidad (máx./mín.) | 1,72 | 1,80 |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 12/12 | 12/12 |
| Precio unitario implícito en 0,50-15 € | 12/12 | 12/12 |
| Solo nombre: la razón marca la suposición | 4/4 | 4/4 |
| Tokens de entrada / salida | 32324 / 4455 | 37986 / 4448 |
| Coste (por decisión) | 0,0352 € (0,0022 €) | 0,0388 € (0,0024 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,006 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v3: rel. · conf. | v6: rel. · conf. | Δ conf. | v3: cantidad · presupuesto | v6: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Cosmética Velilo S.L.U. | rich | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 500-1000 u · 1800-3800 € | 500-920 u · 1850-3800 € |
| Zorarix Promocional S.L.U. | rich | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |
| Ayuntamiento de Torrebruma | rich | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |
| Envases Praxexa de Lirivalle | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,55 | 0,00 | 610-900 u · 750-1400 € | 610-900 u · 850-1500 € |
| Quenilo Holding S.L.U. | name_only | 2/2 · 0,55 / 0,55 | 2/2 · 0,55 / 0,50 | -0,03 | 250-350 u · 600-1100 € | 260-500 u · 650-1400 € |
| Velarix Cosmética S.L. | rich | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 300-500 u · 150-350 € | 320-500 u · 250-550 € |
| Conservas Luxolva S.A. | rich | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,80 | -0,03 | 720-1500 u · 1800-3800 € | 410-810 u · 1200-2400 € |
| Conservas Talvitra S.A. | rich | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 720-1200 u · 1650-3300 € | 500-750 u · 1650-2950 € |

#### Necesidad y razón (última repetición válida)

- **Cosmética Velilo S.L.U.** (rich)
  - v3 · razón: Empresa privada de tamaño medio (130 empleados) con lanzamiento de producto específico en la feria, lo que asegura necesidad de merchandising. Aunque no se precisa el tamaño exacto del stand, su presencia confirmada y perfil encajan perfectamente.
  - v3 · need: Unas 400 bolsas de algodón para muestras de la nueva línea solar, 400 neceseres de yute o algodón promocionales y 20 polos bordados para el equipo comercial del stand. · productos: Bolsas tote de algodón personalizadas, Neceseres de algodón o lona, Polos bordados, Lanyards con acreditación, Botellas térmicas reutilizables · NEXT_QUARTER · OFERTAS, TALLER_PROPIO, TRATO_CERCANO
  - v6 · razón: Empresa privada de tamaño relevante (130 empleados) que presenta un nuevo producto en la feria, con alta necesidad de merchandising promocional y de imagen. Aunque no se precisa el tamaño del stand, su perfil de fabricante avala una presencia comercial destacada.
  - v6 · need: Unas 500 bolsas tote de algodón orgánico para entregar muestras de la nueva línea solar, 400 neceseres de viaje y 20 polos bordados para el equipo comercial del stand. · productos: Bolsas tote de algodón orgánico, Neceseres de viaje personalizados, Polos bordados para personal, Botellas reutilizables, Lanyards con acreditación · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Zorarix Promocional S.L.U.** (rich)
  - v3 · razón: Se descarta porque es un competidor directo cuyo negocio principal es la venta de merchandising y regalo publicitario. PubliEXPE no comercializa sus servicios a empresas del mismo sector.
  - v6 · razón: Se trata de un competidor directo cuyo negocio principal es la venta de merchandising y regalo publicitario personalizado. Queda descartado para la prospección comercial de PubliEXPE.
- **Ayuntamiento de Torrebruma** (rich)
  - v3 · razón: Se trata de un organismo de la administración pública que gestiona compras por licitación oficial, quedando fuera del circuito comercial de prospección directa de PubliEXPE.
  - v6 · razón: Se trata de un organismo de la administración pública que gestiona compras mediante licitación, quedando fuera del circuito comercial de prospección directa de PubliEXPE.
- **Envases Praxexa de Lirivalle** (name_only)
  - v3 · razón: Por el nombre, parece una empresa privada del sector de envases y embalajes para hostelería con presencia ferial; al disponer solo del nombre, se asume un stand de tamaño estándar con confianza moderada.
  - v3 · need: Unas 300 bolsas de tela para entregar catálogos de producto a visitantes profesionales, 300 bolígrafos grabados y 10 polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Bolígrafos promocionales, Polos bordados, Lanyards corporativos · NEXT_QUARTER · TRATO_CERCANO, PRECIO, TALLER_PROPIO
  - v6 · razón: Por el nombre, parece una empresa privada fabricante o distribuidora de envases para hostelería; al no disponer de web ni descripción, calculamos para un stand estándar.
  - v6 · need: Unas 300 bolsas de tela para entregar catálogos de packaging a hosteleros, 300 bolígrafos y 10 polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Bolígrafos publicitarios, Polos bordados para equipo, Lanyards con portatarjetas · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO
- **Quenilo Holding S.L.U.** (name_only)
  - v3 · razón: Empresa privada exponiendo en un salón de hostelería, pero solo disponemos de la razón social y por su nombre parece una sociedad holding. Estimamos necesidades para un stand estándar de feria asumiendo actividad comercial en el sector.
  - v3 · need: Unas 300 bolsas de tela de algodón para entrega de catálogos a profesionales y 10 polos bordados para el personal del stand. · productos: bolsas tote de algodón personalizadas, polos bordados, bolígrafos, libretas con logotipo · NEXT_QUARTER · TRATO_CERCANO, PRECIO
  - v6 · razón: Empresa privada que expone en una feria de hostelería a unos 115 días vista, pero al tener solo el nombre comercial y suponer un stand estándar la confianza no supera 0,5.
  - v6 · need: Unas 250 libretas con bolígrafo para visitantes del stand y 10 delantales o polos bordados para el personal técnico y comercial. · productos: libretas personalizadas, bolígrafos, delantales bordados, polos bordados, bolsas tote de algodón · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO
- **Velarix Cosmética S.L.** (rich)
  - v3 · razón: Empresa privada consolidada (330 empleados) con stand de 80 m² y presentación de nueva línea que requiere merchandising promocional para la feria.
  - v3 · need: Unas 300 unidades de bolígrafos publicitarios con logotipo para entregar a los visitantes y clientes potenciales en su stand de 80 m². · productos: Bolígrafos ecológicos de bambú personalizados, Bolígrafos metálicos grabados en láser, Libretas de notas con portada de cartón reciclado · NEXT_QUARTER · PRECIO, TALLER_PROPIO, TRATO_CERCANO
  - v6 · razón: Empresa privada consolidada con 330 empleados y stand de 80 m² presentando nueva línea de producto. La feria se celebra a unos 115 días, tiempo óptimo dentro de la ventana comercial.
  - v6 · need: Unas 300 unidades de bolígrafos ecológicos grabados para visitantes del stand y unas 20 acreditaciones o lanyards para sus 8 comerciales. · productos: bolígrafos ecológicos de bambú o cartón reciclado, lanyards personalizados, bolsas tote de algodón orgánico · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Conservas Luxolva S.A.** (rich)
  - v3 · razón: Empresa privada de 50 empleados del sector gourmet con lanzamiento de producto confirmado en la feria. Al no conocerse el tamaño exacto del stand, se estima una presencia media habitual para este perfil.
  - v3 · need: Unas 400 bolsas de algodón para entregar muestras de la nueva línea gourmet, 20 delantales o polos bordados para el personal del stand y 300 abridores o detalles promocionales para hosteleros. · productos: bolsas tote de algodón personalizadas, polos bordados para personal, delantales personalizados, sacacorchos y abridores multiusos grabados, libretas con bolígrafo para pedidos · NEXT_QUARTER · OFERTAS, TALLER_PROPIO, TRATO_CERCANO
  - v6 · razón: Empresa privada de 50 empleados que presenta un lanzamiento de producto gourmet en la feria, con encaje idóneo para merchandising de degustación y fidelización. Al no detallar el tamaño del stand, se plantea una estimación para presencia mediana.
  - v6 · need: Unas 400 bolsas de tela de algodón para entregar con el catálogo del nuevo lanzamiento, 400 bolígrafos y delantales bordados para el personal de atención y degustación (unos 10 delantales). · productos: bolsas tote de algodón personalizadas, delantales bordados para hostelería, bolígrafos promocionales, libretas para notas · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO, OFERTAS
- **Conservas Talvitra S.A.** (rich)
  - v3 · razón: Empresa privada consolidada con 110 empleados que presenta una nueva línea de producto en feria, lo que asegura necesidad de material promocional para el stand y lanzamientos.
  - v3 · need: Unas 400 bolsas de tela personalizadas para entregar catálogos de la nueva línea, 20 delantales o polos bordados para el personal del stand y 300 abridores de latas o detalles gourmet para clientes. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina bordados, Polos bordados, Abridores y sacacorchos personalizados, Libretas y bolígrafos para notas comerciales · NEXT_QUARTER · TRATO_CERCANO, TALLER_PROPIO, OFERTAS
  - v6 · razón: Empresa privada consolidada de 110 empleados que acude a la feria a presentar una nueva línea de producto, con un perfil idóneo para merchandising promocional y textil corporativo.
  - v6 · need: Unas 400 bolsas de tela personalizadas para entregar muestras y catálogos a distribuidores, 300 abridores gourmet grabados a láser y 20 delantales o polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Delantales de hostelería bordados, Polos corporativos bordados, Abridores metálicos grabados a láser, Libretas y bolígrafos para notas de cata · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO

Fase VALIDATION · fixture `EXP-004/validation-2`

#### Comparación v3 vs v6 — `prospector-event-exhibitors`

- Entrada: Expo Gastronómica de Valdecristal 2027, 3 expositores, 2 repetición(es) por versión. Hash de la entrada: `e9a5437310a94f37`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-12. CRM: FakeTwenty (en memoria).
- Coste total: 0,0269 € de un presupuesto de 0,2000 €.

| Métrica | v3 | v6 |
|---|---|---|
| Decisiones (errores) | 6 (0) | 6 (0) |
| Relevantes | 4 | 4 |
| Escribibles (confianza ≥ umbral) | 4 | 4 |
| Confianza media (todas las decisiones) | 0,53 | 0,53 |
| Confianza media (solo relevantes) | 0,78 | 0,78 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (nombre + sector) | 0,70 / 0,70 (n=2) | 0,70 / 0,70 (n=2) |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,85 / 0,85 (n=2) | 0,85 / 0,85 (n=2) |
| Hipótesis | 4 | 4 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 450-750 u / 1800-3500 € (×1) | 500-1000 u / 1800-3600 € (×1) |
| Amplitud media cantidad (máx./mín.) | 1,92 | 1,83 |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 4/4 | 4/4 |
| Precio unitario implícito en 0,50-15 € | 4/4 | 4/4 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 12108 / 1493 | 14238 / 1568 |
| Coste (por decisión) | 0,0126 € (0,0021 €) | 0,0142 € (0,0024 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,000 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v3: rel. · conf. | v6: rel. · conf. | Δ conf. | v3: cantidad · presupuesto | v6: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Quesos Zoritra S.L.U. | rich | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 720-1400 u · 1850-3800 € | 500-750 u · 1800-3500 € |
| Drovitra Mercados Centrales S.A.U. | rich | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |
| Velarix Envases S.A. | sector | 2/2 · 0,70 / 0,70 | 2/2 · 0,70 / 0,70 | 0,00 | 415-830 u · 950-1900 € | 310-600 u · 750-1600 € |

#### Necesidad y razón (última repetición válida)

- **Quesos Zoritra S.L.U.** (rich)
  - v3 · razón: Empresa privada de tamaño relevante (190 empleados) con presencia internacional que presenta nuevo producto en feria. Al no conocer los metros de stand, estimamos necesidades medias de merchandising.
  - v3 · need: Unas 400 bolsas de algodón para catas y muestras, 20 delantales bordados para el equipo del stand y 300 libretas con bolígrafo para compradores profesionales. · productos: bolsas tote de algodón personalizadas, delantales bordados, libretas personalizadas, bolígrafos, lanyards · LATER · OFERTAS, TALLER_PROPIO, TRATO_CERCANO
  - v6 · razón: Empresa privada de tamaño relevante (190 empleados) con presencia internacional que presenta nuevo producto en feria. Al faltar más de 8 meses, hay margen ideal para preparar la propuesta con calma.
  - v6 · need: Unas 400 bolsas de algodón para entregar muestras del nuevo queso y catálogos a distribuidores, 20 delantales o polos bordados para el personal del stand y 300 tablas de corte o navajas queseras personalizadas como obsequio prémium. · productos: Bolsas tote de algodón personalizadas, Delantales personalizados, Polos bordados, Tablas de corte de madera personalizadas a láser, Bolígrafos metálicos grabados · LATER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Drovitra Mercados Centrales S.A.U.** (rich)
  - v3 · razón: Se trata de una sociedad mercantil de capital íntegramente público que contrata mediante licitación pública bajo la LCSP. Por tanto, queda fuera del circuito de prospección comercial directa de PubliEXPE.
  - v6 · razón: Se trata de una empresa de capital íntegramente público que adjudica sus compras mediante licitación pública sujeta a la LCSP. Queda fuera del circuito de venta comercial directa de PubliEXPE.
- **Velarix Envases S.A.** (sector)
  - v3 · razón: Empresa privada del sector de packaging alimentario exponiendo en una feria gastronómica, susceptible de requerir textil para su equipo y obsequios para visitantes. Contamos solo con nombre y sector, por lo que se asume un stand de tamaño medio y la confianza queda topada en 0,75.
  - v3 · need: Unas 400 bolsas de tela personalizadas para entregar catálogos de packaging a los visitantes y 15 polos bordados para el equipo del stand. · productos: Bolsas tote de algodón personalizadas, Polos bordados para empresa, Bolígrafos ecológicos, Libretas corporativas · LATER · OFERTAS, TRATO_CERCANO, PRECIO
  - v6 · razón: Empresa privada del sector packaging que expone en una feria gastronómica, con encaje directo para textil de equipo y regalo corporativo. Al contar solo con nombre y sector, se dimensiona para un stand mediano.
  - v6 · need: Unas 300 bolsas tote personalizadas para entregar muestras de envases y catálogo a los visitantes, y 10 polos bordados para el personal técnico y comercial del stand. · productos: bolsas tote de algodón personalizadas, polos bordados, libretas con bolígrafo, lanyards personalizados · LATER · TALLER_PROPIO, TRATO_CERCANO, PRECIO

Fase VALIDATION · fixture `EXP-004/validation-3`

#### Comparación v3 vs v6 — `prospector-event-exhibitors`

- Entrada: Feria de Alimentación de Quintaluz 2027, 3 expositores, 2 repetición(es) por versión. Hash de la entrada: `5a93190dfa59216d`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-12. CRM: FakeTwenty (en memoria).
- Coste total: 0,0270 € de un presupuesto de 0,2000 €.

| Métrica | v3 | v6 |
|---|---|---|
| Decisiones (errores) | 6 (0) | 6 (0) |
| Relevantes | 4 | 4 |
| Escribibles (confianza ≥ umbral) | 4 | 4 |
| Confianza media (todas las decisiones) | 0,59 | 0,60 |
| Confianza media (solo relevantes) | 0,87 | 0,87 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,87 / 0,88 (n=4) | 0,87 / 0,88 (n=4) |
| Hipótesis | 4 | 4 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 600-900 u / 1200-2200 € (×1) | 500-900 u / 1100-2200 € (×1) |
| Amplitud media cantidad (máx./mín.) | 1,65 | 1,75 |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 4/4 | 4/4 |
| Precio unitario implícito en 0,50-15 € | 4/4 | 4/4 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 12192 / 1497 | 14312 / 1579 |
| Coste (por decisión) | 0,0127 € (0,0021 €) | 0,0143 € (0,0024 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,005 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v3: rel. · conf. | v6: rel. · conf. | Δ conf. | v3: cantidad · presupuesto | v6: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Velezna Envases S.L.U. | rich | 2/2 · 0,88 / 0,88 | 2/2 · 0,88 / 0,88 | 0,00 | 500-900 u · 1200-2500 € | 600-1000 u · 1200-2500 € |
| Bodegas Karvovix S.L. | rich | 2/2 · 0,85 / 0,85 | 2/2 · 0,88 / 0,85 | 0,02 | 350-600 u · 1200-2500 € | 500-800 u · 1800-3200 € |
| Ayuntamiento de Quintaluz | sector | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |

#### Necesidad y razón (última repetición válida)

- **Velezna Envases S.L.U.** (rich)
  - v3 · razón: Empresa privada de tamaño mediano con stand propio de 30 m², lanzamiento de producto y necesidad explícita de obsequios promocionales para la feria.
  - v3 · need: Unas 400 bolsas de algodón reciclado y 400 libretas con bolígrafo para visitantes del stand, además de 10 polos bordados para los 5 comerciales. · productos: Bolsas tote de algodón reciclado o ecológico, Libretas con bolígrafo ecológico, Polos bordados para el equipo del stand, Lanyards personalizados · NEXT_QUARTER · OFERTAS, TRATO_CERCANO, PRECIO
  - v6 · razón: Empresa privada de tamaño mediano con presencia comercial activa (stand de 30 m² y 5 comerciales) y presentación de un nuevo producto, con clara intención de repartir obsequios.
  - v6 · need: Unas 400 bolsas de algodón reciclado para entregar con muestras de las bandejas compostables, 500 bolígrafos ecológicos y 10 polos bordados para el equipo comercial del stand. · productos: Bolsas tote de algodón orgánico o reciclado, Bolígrafos ecológicos de fibra de trigo, Polos bordados para el equipo del stand, Libretas de papel reciclado · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Bodegas Karvovix S.L.** (rich)
  - v3 · razón: Empresa privada de tamaño medio-grande (370 empleados) con stand amplio de 90 m², presentación de nuevo producto y necesidad explícita de regalo promocional para visitantes.
  - v3 · need: Unas 400 bolsas de tela o estuches para botellas y sacacorchos personalizados para visitantes del stand, además de 12 polos o camisas bordadas para el equipo comercial. · productos: bolsas tote de algodón personalizadas, sacacorchos personalizados, polos bordados, libretas con bolígrafo · NEXT_QUARTER · TALLER_PROPIO, PRECIO, TRATO_CERCANO
  - v6 · razón: Empresa privada de tamaño relevante (370 empleados) con stand de 90 m² y presentación de nuevo producto en la feria. Presenta una clara necesidad de merchandising tanto para visitantes como para el equipo comercial.
  - v6 · need: Unas 500 bolsas de tela personalizadas para visitantes del stand, 250 sacacorchos grabados para clientes selectos y 12 camisas o polos bordados para el equipo comercial. · productos: Bolsas tote de algodón personalizadas, Sacacorchos y abridores grabados en láser, Polos o camisas bordadas para el equipo, Libretas personalizadas para notas de cata · NEXT_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Ayuntamiento de Quintaluz** (sector)
  - v3 · razón: Se trata de un organismo público (ayuntamiento) que gestiona sus compras a través de licitaciones públicas, quedando fuera del circuito comercial directo de PubliEXPE.
  - v6 · razón: Se trata de una administración pública (ayuntamiento), por lo que sus compras se gestionan mediante licitación pública y queda fuera del circuito comercial de prospección.

Fase VALIDATION · fixture `EXP-004/validation-4`

#### Comparación v3 vs v6 — `prospector-event-exhibitors`

- Entrada: Salón de Hostelería de Velandria 2027, 1 expositores, 2 repetición(es) por versión. Hash de la entrada: `4961340561704568`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2027-09-08. CRM: FakeTwenty (en memoria).
- Coste total: 0,0105 € de un presupuesto de 0,2000 €.

| Métrica | v3 | v6 |
|---|---|---|
| Decisiones (errores) | 2 (0) | 2 (0) |
| Relevantes | 2 | 2 |
| Escribibles (confianza ≥ umbral) | 2 | 2 |
| Confianza media (todas las decisiones) | 0,88 | 0,87 |
| Confianza media (solo relevantes) | 0,88 | 0,87 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,88 / 0,88 (n=2) | 0,87 / 0,88 (n=2) |
| Hipótesis | 2 | 2 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 612-900 u / 1800-3600 € (×1) | 500-800 u / 1200-2300 € (×1) |
| Amplitud media cantidad (máx./mín.) | 1,47 | 1,52 |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 2/2 | 2/2 |
| Precio unitario implícito en 0,50-15 € | 2/2 | 2/2 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 4104 / 697 | 4814 / 770 |
| Coste (por decisión) | 0,0049 € (0,0024 €) | 0,0056 € (0,0028 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,015 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v3: rel. · conf. | v6: rel. · conf. | Δ conf. | v3: cantidad · presupuesto | v6: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Quesos Brixezna Export S.L. | rich | 2/2 · 0,88 / 0,88 | 2/2 · 0,88 / 0,85 | -0,02 | 812-1200 u · 1650-2900 € | 450-650 u · 1800-3200 € |

#### Necesidad y razón (última repetición válida)

- **Quesos Brixezna Export S.L.** (rich)
  - v3 · razón: Empresa privada consolidada con 110 empleados, presencia destacada con stand de 50 m², lanzamiento de producto y búsqueda activa explícita de regalos promocionales para el evento.
  - v3 · need: Unas 400 bolsas de algodón personalizadas y 400 libretas con bolígrafo para visitantes del stand, además de 12 delantales o polos bordados para los 6 comerciales. · productos: bolsas tote de algodón personalizadas, bolígrafos, libretas, delantales bordados, polos bordados · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v6 · razón: Empresa privada consolidada con 110 empleados, presencia relevante (stand de 50 m², 6 comerciales) y lanzamiento de nuevo producto en la feria. El evento es el 07/12/2027 (faltan 90 días), lo que encaja perfectamente en la ventana comercial ideal.
  - v6 · need: Unas 400 bolsas de algodón serigrafiadas para entregar a visitantes, 30 delantales o polos bordados para el equipo del stand y 80 sets gourmets o tablas de queso grabadas a láser para clientes clave y distribuidores. · productos: Bolsas tote de algodón personalizadas, Delantales o polos bordados, Tablas de cortar de madera grabadas a láser, Bolígrafos metálicos promocionales, Libretas para notas · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO

Fase VALIDATION · fixture `EXP-004/validation-5`

#### Comparación v3 vs v6 — `prospector-event-exhibitors`

- Entrada: Expo Gastronómica de Valdecristal 2027, 1 expositores, 2 repetición(es) por versión. Hash de la entrada: `a09bdc91fe67524a`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2027-06-05. CRM: FakeTwenty (en memoria).
- Coste total: 0,0086 € de un presupuesto de 0,2000 €.

| Métrica | v3 | v6 |
|---|---|---|
| Decisiones (errores) | 2 (0) | 2 (0) |
| Relevantes | 2 | 0 |
| Escribibles (confianza ≥ umbral) | 2 | 0 |
| Confianza media (todas las decisiones) | 0,90 | 0,05 |
| Confianza media (solo relevantes) | 0,90 | — |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,90 / 0,90 (n=2) | — / — (n=0) |
| Hipótesis | 2 | 0 |
| Rangos distintos / hipótesis | 1,00 | — |
| Rango más repetido | 400-600 u / 1200-2500 € (×1) | — |
| Amplitud media cantidad (máx./mín.) | 1,59 | — |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 2/2 | 0/0 |
| Precio unitario implícito en 0,50-15 € | 2/2 | 0/0 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 4132 / 721 | 4846 / 162 |
| Coste (por decisión) | 0,0050 € (0,0025 €) | 0,0036 € (0,0018 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,000 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v3: rel. · conf. | v6: rel. · conf. | Δ conf. | v3: cantidad · presupuesto | v6: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Quesos Karvaqui Export S.L.U. | rich | 2/2 · 0,90 / 0,90 | 0/2 · 0,05 / 0,05 | -0,85 | 715-1200 u · 1800-3500 € | — |

#### Necesidad y razón (última repetición válida)

- **Quesos Karvaqui Export S.L.U.** (rich)
  - v3 · razón: Empresa privada de gran tamaño (300 empleados) con stand de 60 m² y presentación de nuevo producto en la feria. Cuentan con necesidad activa y confirmada de merchandising para el evento inminente.
  - v3 · need: Unas 400 bolsas de algodón para entregar muestras y catálogos a visitantes, 15 delantales o polos bordados para el equipo del stand y 300 tablas de corte o navajas queseras personalizadas para clientes clave. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina bordados, Polos técnicos o de algodón bordados, Tablas de corte o accesorios de queso grabados a láser, Bolígrafos metálicos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v6 · razón: Fuera de ventana comercial: faltan solo 8 días para la feria (se celebra el 13/06/2027), lo cual no deja margen mínimo de 45 días para una producción adecuada.

## Anexo B · Evaluación automática

#### Evaluación · EXP-004 · VALIDATION

- Generado: 2026-10-12T16:22:43.942Z. Composite: `composite.commercial_score@1` (`372504cd576e`).
- Juez: gemini-pro-latest · 3 llamadas · 0,0435 € de 0,10 € (**presupuesto agotado**) · 23 casos sin nota del juez.

| | v3 | v6 |
|---|---|---|
| **Veredicto** | **PASS** | **PASS** |
| **Score compuesto** | **0,988** | **0,992** |
| Restricciones duras incumplidas | ninguna | ninguna |
| Casos | 32 | 32 |
| TASK_SUCCESS (peso efectivo) | 1,000 (0,353) | 1,000 (0,353) |
| NEXT_ACTION_QUALITY (peso efectivo) | 1,000 (0,118) | 1,000 (0,118) |
| FACTUALITY (peso efectivo) | 0,980 (0,235) | 0,980 (0,235) |
| COMMERCIAL_RELEVANCE (peso efectivo) | 0,938 (0,118) | 0,969 (0,118) |
| SOURCE_QUALITY (peso efectivo) | 1,000 (0,177) | 1,000 (0,177) |
| POLICY_COMPLIANCE (peso efectivo) | 1,000 (0,000) | 1,000 (0,000) |
| Sin evaluar (peso redistribuido) | CRM_CORRECTNESS | CRM_CORRECTNESS |

##### Por evaluador

| Evaluador | Tipo | Dimensión | Dura | v3: score · fallos/aplicables | v6: score · fallos/aplicables |
|---|---|---|---|---|---|
| `rule.decision_valid@1` | RULE | TASK_SUCCESS | no | 1,000 · 0/32 | 1,000 · 0/32 |
| `rule.need_has_quantities@1` | RULE | NEXT_ACTION_QUALITY | no | 1,000 · 0/24 | 1,000 · 0/22 |
| `rule.quantity_spread_le_2_5@1` | RULE | NEXT_ACTION_QUALITY | no | 1,000 · 0/24 | 1,000 · 0/22 |
| `rule.budget_derived@1` | RULE | FACTUALITY | no | 1,000 · 0/24 | 1,000 · 0/22 |
| `rule.assumptions_marked@1` | RULE | FACTUALITY | no | 1,000 · 0/4 | 1,000 · 0/4 |
| `rule.confidence_capped_by_data@1` | RULE | FACTUALITY | no | 1,000 · 0/6 | 1,000 · 0/6 |
| `rule.discard_confidence_low@1` | RULE | COMMERCIAL_RELEVANCE | sí | 1,000 · 0/8 | 1,000 · 0/10 |
| `rule.source_urls_known@1` | RULE | SOURCE_QUALITY | sí | 1,000 · 0/32 | 1,000 · 0/32 |
| `synth.decision@1` | RULE | COMMERCIAL_RELEVANCE | no | 0,875 · 4/32 | 0,938 · 2/32 |
| `synth.quantities@1` | RULE | FACTUALITY | no | 0,900 · 1/10 | 0,900 · 1/10 |
| `synth.assumptions@1` | RULE | FACTUALITY | no | 1,000 · 0/8 | 1,000 · 0/8 |
| `synth.injection@1` | RULE | POLICY_COMPLIANCE | no | 1,000 · 0/4 | 1,000 · 0/4 |
| `judge.next_action_quality@1` | LLM_JUDGE | NEXT_ACTION_QUALITY | no | 1,000 · 0/12 | 1,000 · 0/11 |
| `judge.commercial_relevance@1` | LLM_JUDGE | COMMERCIAL_RELEVANCE | no | — (12 errores) | — (11 errores) |

##### Por sujeto

| Sujeto | Veredicto | Score | Duras incumplidas |
|---|---|---|---|
| v3 · validation-1 · r1 | PASS | 0,981 | — |
| v6 · validation-1 · r1 | PASS | 0,993 | — |
| v6 · validation-1 · r2 | PASS | 0,981 | — |
| v3 · validation-1 · r2 | PASS | 0,993 | — |
| v3 · validation-2 · r1 | PASS | 1,000 | — |
| v6 · validation-2 · r1 | PASS | 1,000 | — |
| v6 · validation-2 · r2 | PASS | 1,000 | — |
| v3 · validation-2 · r2 | PASS | 1,000 | — |
| v3 · validation-3 · r1 | PASS | 1,000 | — |
| v6 · validation-3 · r1 | PASS | 1,000 | — |
| v6 · validation-3 · r2 | PASS | 1,000 | — |
| v3 · validation-3 · r2 | PASS | 1,000 | — |
| v3 · validation-4 · r1 | PASS | 1,000 | — |
| v6 · validation-4 · r1 | PASS | 1,000 | — |
| v6 · validation-4 · r2 | PASS | 1,000 | — |
| v3 · validation-4 · r2 | PASS | 1,000 | — |
| v3 · validation-5 · r1 | PASS | 0,882 | — |
| v6 · validation-5 · r1 | PASS | 1,000 | — |
| v6 · validation-5 · r2 | PASS | 1,000 | — |
| v3 · validation-5 · r2 | PASS | 0,882 | — |

##### Notas del juez

| Sujeto | Caso | Dimensión | Nivel | Justificación | Cita |
|---|---|---|---|---|---|
| v3 · validation-1 · r1 | Cosmética Velilo S.L.U. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 500 bolsas de algodón orgánico y 500 neceseres personalizados para entregar muestras» |
| v3 · validation-1 · r1 | Envases Praxexa de Lirivalle | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 300 bolsas de tela personalizadas para entregar catálogos o muestras a hosteleros, 200 bolígrafos» |
| v3 · validation-1 · r1 | Quenilo Holding S.L.U. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 200 bolsas de tela personalizadas para folletos, 300 bolígrafos para visitantes y 10 delantales» |
| v3 · validation-1 · r1 | Velarix Cosmética S.L. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unos 300 bolígrafos ecológicos grabados para visitantes del stand y unas 15 prendas corporativas» |
| v3 · validation-1 · r1 | Conservas Luxolva S.A. | NEXT_ACTION_QUALITY | 4 | La hipótesis detalla cantidades exactas por producto, un presupuesto coherente, un motivo ligado al evento y un diferencial pertinente (taller propio). | «Unas 400 bolsas de algodón» |
| v3 · validation-1 · r1 | Conservas Talvitra S.A. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 400 bolsas de tela personalizadas para muestras de la nueva ventresca, 20 delantales» |
| v6 · validation-1 · r1 | Cosmética Velilo S.L.U. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 400 bolsas tote de algodón orgánico para entregar muestras del protector solar a visitantes» |
| v6 · validation-1 · r1 | Envases Praxexa de Lirivalle | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 300 bolsas de algodón para entregar catálogos en el stand, 200 bolígrafos grabados» |
| v6 · validation-1 · r1 | Quenilo Holding S.L.U. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 300 bolsas de algodón y 400 bolígrafos para visitantes del stand, además de 10 delantales» |
| v6 · validation-1 · r1 | Velarix Cosmética S.L. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 300 unidades de bolígrafos personalizados para repartir a los visitantes del stand» |
| v6 · validation-1 · r1 | Conservas Luxolva S.A. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 400 bolsas de tela personalizadas para degustaciones y catas, 250 libretas con bolígrafo» |
| v6 · validation-1 · r1 | Conservas Talvitra S.A. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 400 bolsas de algodón personalizadas para la entrega de muestras y catálogos, 300 delantales» |
| v3 · validation-2 · r1 | Quesos Zoritra S.L.U. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable para presupuestar. | «Unas 400 bolsas de algodón para muestras y documentación comercial, 20 delantales o polos bordados» |
| v3 · validation-2 · r1 | Velarix Envases S.A. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 350 bolsas de tela personalizadas para entregar catálogos de envases a visitantes y 15 polos» |
| v6 · validation-2 · r1 | Quesos Zoritra S.L.U. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 400 bolsas de algodón para entrega de catálogos y muestras a distribuidores, 20 delantales» |
| v6 · validation-2 · r1 | Velarix Envases S.A. | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferenciales pertinentes. Totalmente accionable. | «Unas 400 bolsas de tela personalizadas para entregar catálogos de envases, 500 bolígrafos corporativos» |
| v3 · validation-3 · r1 | Velezna Envases S.L.U. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 400 bolsas de algodón reciclado y 400 bolígrafos ecológicos para visitantes del stand» |
| v3 · validation-3 · r1 | Bodegas Karvovix S.L. | NEXT_ACTION_QUALITY | 4 | La hipótesis detalla cantidades exactas por producto, un presupuesto coherente, un motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar directamente. | «Unas 400 bolsas tote personalizadas para entregar con folletos del nuevo espumoso, 250 sacacorchos grabados» |
| v6 · validation-3 · r1 | Velezna Envases S.L.U. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 400 bolsas de algodón reciclado o ecológico para visitantes y clientes, 15 polos bordados» |
| v6 · validation-3 · r1 | Bodegas Karvovix S.L. | NEXT_ACTION_QUALITY | 4 | La hipótesis detalla cantidades exactas por producto, un presupuesto coherente, un motivo ligado al evento y un diferencial pertinente (taller propio). | «Unas 500 bolsas de tela» |
| v3 · validation-4 · r1 | Quesos Brixezna Export S.L. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 400 bolsas de algodón para entregar a visitantes y compradores, 200 tablas pequeñas» |
| v6 · validation-4 · r1 | Quesos Brixezna Export S.L. | NEXT_ACTION_QUALITY | 4 | Cantidades desglosadas por producto, presupuesto coherente, motivo ligado al evento y diferenciales de PubliEXPE. El comercial puede presupuestar ya. | «Unas 400 bolsas de algodón personalizadas para entregar con folletos del nuevo queso, 300 bolígrafos» |
| v3 · validation-5 · r1 | Quesos Karvaqui Export S.L.U. | NEXT_ACTION_QUALITY | 4 | La hipótesis detalla cantidades exactas por producto, un presupuesto coherente, un motivo ligado al evento y un diferencial pertinente (taller propio). | «Unas 400 bolsas de tela» |

##### Llamadas al juez

| Evaluador | Grupo | Modelo servido | Casos | Intentos | Tokens entrada / salida | Coste |
|---|---|---|---|---|---|---|
| `judge.next_action_quality@1` | v3+v6 | gemini-3.1-pro-preview | 20 | 1 | 10103 / 1884 | 0,0368 € |
| `judge.next_action_quality@1` | v3+v6 | gemini-3.1-pro-preview | 3 | 1 | 2426 / 240 | 0,0067 € |
| `judge.commercial_relevance@1` | v3+v6 | gemini-pro-latest | 20 | 0 | 0 / 0 | 0,0000 € (error: presupuesto del juez: 0.0435 € gastados + 0.0618 € previstos superan 0.1000 €) |

