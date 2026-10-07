### Evaluación automática · ../../docs/experimentos/EXP-002/compare-v1-v3.json

- Generado: 2026-10-07T15:22:22.345Z. Composite: `composite.commercial_score@1` (`372504cd576e`).
- Juez: gemini-pro-latest · 2 llamadas · 0,0636 € de 0,10 € · 0 casos sin nota del juez.

| | v1 | v3 |
|---|---|---|
| **Veredicto** | **PASS** | **PASS** |
| **Score compuesto** | **0,706** | **0,978** |
| Restricciones duras incumplidas | ninguna | ninguna |
| Casos | 26 | 26 |
| TASK_SUCCESS (peso efectivo) | 1,000 (0,353) | 1,000 (0,353) |
| NEXT_ACTION_QUALITY (peso efectivo) | 0,167 (0,118) | 1,000 (0,118) |
| FACTUALITY (peso efectivo) | 0,292 (0,235) | 0,967 (0,235) |
| COMMERCIAL_RELEVANCE (peso efectivo) | 0,750 (0,118) | 0,875 (0,118) |
| SOURCE_QUALITY (peso efectivo) | 1,000 (0,177) | 1,000 (0,177) |
| Sin evaluar (peso redistribuido) | CRM_CORRECTNESS | CRM_CORRECTNESS |

#### Por evaluador

| Evaluador | Tipo | Dimensión | Dura | v1: score · fallos/aplicables | v3: score · fallos/aplicables |
|---|---|---|---|---|---|
| `rule.decision_valid@1` | RULE | TASK_SUCCESS | no | 1,000 · 0/26 | 1,000 · 0/26 |
| `rule.need_has_quantities@1` | RULE | NEXT_ACTION_QUALITY | no | 0,000 · 20/20 | 1,000 · 0/20 |
| `rule.quantity_spread_le_2_5@1` | RULE | NEXT_ACTION_QUALITY | no | 0,000 · 20/20 | 1,000 · 0/20 |
| `rule.budget_derived@1` | RULE | FACTUALITY | no | 0,500 · 20/20 | 1,000 · 0/20 |
| `rule.assumptions_marked@1` | RULE | FACTUALITY | no | 0,000 · 10/10 | 0,900 · 1/10 |
| `rule.confidence_capped_by_data@1` | RULE | FACTUALITY | no | 0,375 · 10/16 | 1,000 · 0/16 |
| `rule.discard_confidence_low@1` | RULE | COMMERCIAL_RELEVANCE | sí | 1,000 · 0/6 | 1,000 · 0/6 |
| `rule.source_urls_known@1` | RULE | SOURCE_QUALITY | sí | 1,000 · 0/26 | 1,000 · 0/26 |
| `judge.next_action_quality@1` | LLM_JUDGE | NEXT_ACTION_QUALITY | no | 0,500 · 0/10 | 1,000 · 0/10 |
| `judge.commercial_relevance@1` | LLM_JUDGE | COMMERCIAL_RELEVANCE | no | 0,500 · 0/10 | 0,750 · 0/10 |

#### Por sujeto

| Sujeto | Veredicto | Score | Duras incumplidas |
|---|---|---|---|
| v1 · organismos-publicos-sinteticos · r1 | PASS | 1,000 | — |
| v3 · organismos-publicos-sinteticos · r1 | PASS | 1,000 | — |
| v3 · organismos-publicos-sinteticos · r2 | PASS | 1,000 | — |
| v1 · organismos-publicos-sinteticos · r2 | PASS | 1,000 | — |
| v1 · gastronoma-holdout-2 · r1 | PASS | 0,677 | — |
| v3 · gastronoma-holdout-2 · r1 | PASS | 0,978 | — |
| v3 · gastronoma-holdout-2 · r2 | PASS | 0,982 | — |
| v1 · gastronoma-holdout-2 · r2 | PASS | 0,678 | — |
| v1 · feria-ejemplo · r1 | PASS | 0,755 | — |
| v3 · feria-ejemplo · r1 | PASS | 0,971 | — |
| v3 · feria-ejemplo · r2 | PASS | 1,000 | — |
| v1 · feria-ejemplo · r2 | PASS | 0,765 | — |

#### Notas del juez

| Sujeto | Caso | Dimensión | Nivel | Justificación | Cita |
|---|---|---|---|---|---|
| v1 · gastronoma-holdout-2 · r1 | MYBAOS SL | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla amplia (100-400), lo que impide presupuestar directamente. | «Material promocional para captar clientes en stand» |
| v1 · gastronoma-holdout-2 · r1 | PREZO | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla muy amplia (250-1000), lo que impide presupuestar directamente. | «Material promocional para captar clientes en su stand» |
| v1 · gastronoma-holdout-2 · r1 | QBO DELICIAS SL | NEXT_ACTION_QUALITY | 2 | Propone productos y propósito claros, pero la cantidad es una horquilla demasiado amplia (250-1000) sin desglose por producto, lo que dificulta presupuestar. | «Material promocional para obsequiar a visitantes» |
| v1 · gastronoma-holdout-2 · r1 | SERHS PROJECTS | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla amplia (250-800), lo que impide presupuestar directamente. | «Material corporativo para los comerciales en el stand» |
| v1 · gastronoma-holdout-2 · r1 | TEMPLO CAFÉS | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla muy amplia (300-1500), lo que impide presupuestar directamente. | «Artículos promocionales de temática hostelera» |
| v1 · gastronoma-holdout-2 · r1 | UNOX | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla amplia (300-1200), lo que impide presupuestar directamente. | «Dotación de delantales y chaquetillas técnicas personalizadas» |
| v1 · gastronoma-holdout-2 · r1 | VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla amplia (250-1000), lo que impide presupuestar directamente. | «Artículos promocionales específicos del sector vitivinícola» |
| v1 · gastronoma-holdout-2 · r1 | ZERO,O MIXERS | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla amplia (300-1000), lo que impide presupuestar directamente. | «Artículos promocionales para promocionar sus bebidas» |
| v1 · gastronoma-holdout-2 · r1 | MYBAOS SL | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.65) es algo alta considerando que solo se dispone del nombre, y la necesidad es genérica. | «Material promocional para captar clientes en stand y textil corporativo para el equipo» |
| v1 · gastronoma-holdout-2 · r1 | PREZO | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.7) es demasiado alta para disponer únicamente del nombre del expositor. | «No se aportan detalles de stand o tamaño en la ficha, pero tiene claro encaje comercial.» |
| v1 · gastronoma-holdout-2 · r1 | QBO DELICIAS SL | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.65) es alta para disponer solo del nombre, y la necesidad es genérica. | «La confianza es moderada debido a la falta de detalles sobre el tamaño de la empresa.» |
| v1 · gastronoma-holdout-2 · r1 | SERHS PROJECTS | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.75) es demasiado alta considerando que solo se dispone del nombre del expositor. | «Al faltar detalles sobre el tamaño del stand en los datos, la confianza se sitúa en 0,75.» |
| v1 · gastronoma-holdout-2 · r1 | TEMPLO CAFÉS | COMMERCIAL_RELEVANCE | 2 | Similar al caso anterior, la confianza (0.85) es demasiado alta para disponer solo del nombre y sector, y la necesidad es genérica para el sector. | «Artículos promocionales de temática hostelera y de feria para obsequiar a profesionales del sector» |
| v1 · gastronoma-holdout-2 · r1 | UNOX | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.85) es excesiva para disponer solo del nombre y sector, basándose en conocimiento externo. | «UNOX es un fabricante multinacional líder de hornos profesionales con presencia comercial destacada» |
| v1 · gastronoma-holdout-2 · r1 | VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.75) es algo alta para disponer solo del nombre y sector, y la necesidad es genérica para una bodega. | «Artículos promocionales específicos del sector vitivinícola para obsequiar a sumilleres» |
| v1 · gastronoma-holdout-2 · r1 | ZERO,O MIXERS | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.65) es alta para disponer solo del nombre, y la necesidad es genérica. | «Artículos promocionales para promocionar sus bebidas (mixers) entre hosteleros y distribuidores» |
| v3 · gastronoma-holdout-2 · r1 | MYBAOS SL | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 250 bolsas tote de algodón» |
| v3 · gastronoma-holdout-2 · r1 | PREZO | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 250 libretas con bolígrafo para demostraciones» |
| v3 · gastronoma-holdout-2 · r1 | QBO DELICIAS SL | NEXT_ACTION_QUALITY | 4 | Desglosa unidades por producto, el presupuesto es coherente, el motivo está ligado al evento y el diferencial es pertinente. Totalmente accionable. | «Unas 300 bolsas de tela o papel» |
| v3 · gastronoma-holdout-2 · r1 | SERHS PROJECTS | NEXT_ACTION_QUALITY | 4 | La hipótesis detalla unidades por producto, un presupuesto coherente, un motivo ligado al evento y un diferencial pertinente. El comercial puede presupuestar directamente. | «Unas 250 libretas con bolígrafo para reuniones» |
| v3 · gastronoma-holdout-2 · r1 | TEMPLO CAFÉS | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 400 tazas térmicas o de cerámica» |
| v3 · gastronoma-holdout-2 · r1 | UNOX | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 400 bolsas de tela para catálogos» |
| v3 · gastronoma-holdout-2 · r1 | VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 200 bolsas de tela o yute» |
| v3 · gastronoma-holdout-2 · r1 | ZERO,O MIXERS | NEXT_ACTION_QUALITY | 4 | Desglosa unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 250 bolsas tote de algodón» |
| v3 · gastronoma-holdout-2 · r1 | MYBAOS SL | COMMERCIAL_RELEVANCE | 4 | Encaje claro. La confianza (0.55) está bien calibrada al disponer solo del nombre, y la hipótesis es específica y razonable. | «solo disponemos del nombre social sin detalles de su stand.» |
| v3 · gastronoma-holdout-2 · r1 | PREZO | COMMERCIAL_RELEVANCE | 4 | Encaje claro. La confianza (0.55) está bien calibrada al disponer solo del nombre, y la hipótesis se ajusta a un stand estándar. | «Al recibir solo el nombre sin datos adicionales, calculamos la hipótesis para un stand estándar» |
| v3 · gastronoma-holdout-2 · r1 | QBO DELICIAS SL | COMMERCIAL_RELEVANCE | 4 | Encaje claro. La confianza (0.55) está bien calibrada al disponer solo del nombre, y la hipótesis se ajusta a un stand estándar. | «al no tener descripción ni web se presupone un stand de tamaño estándar y la confianza no supera 0,6.» |
| v3 · gastronoma-holdout-2 · r1 | SERHS PROJECTS | COMMERCIAL_RELEVANCE | 4 | Encaje claro. Al tener solo el nombre, la confianza (0.55) está bien calibrada (baja) y la hipótesis se ajusta a un stand estándar. | «Al recibir únicamente el nombre, la confianza se mantiene prudente y dimensionada para un stand estándar.» |
| v3 · gastronoma-holdout-2 · r1 | TEMPLO CAFÉS | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la razón se basa en 'conocimiento general' y no en los datos proporcionados (solo nombre y sector). La confianza (0.8) es alta para los datos disponibles. | «Templo Cafés es una marca líder y consolidada en el sector hostelero (Horeca) según conocimiento general» |
| v3 · gastronoma-holdout-2 · r1 | UNOX | COMMERCIAL_RELEVANCE | 2 | La razón se apoya en 'conocimiento general' y no en los datos de entrada (solo nombre y sector). La confianza (0.85) es excesiva para la información disponible. | «Por conocimiento general, UNOX es un fabricante internacional referente de hornos profesionales» |
| v3 · gastronoma-holdout-2 · r1 | VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO | COMMERCIAL_RELEVANCE | 2 | El encaje es plausible, pero la confianza (0.7) es alta para disponer solo del nombre y sector. | «al tener únicamente nombre y sector asumimos un stand de tamaño medio-pequeño.» |
| v3 · gastronoma-holdout-2 · r1 | ZERO,O MIXERS | COMMERCIAL_RELEVANCE | 4 | Encaje claro. La confianza (0.55) está bien calibrada al disponer solo del nombre, y la hipótesis se ajusta a un stand estándar. | «Al disponer únicamente del nombre comercial, calculamos para un stand estándar.» |
| v1 · feria-ejemplo · r1 | Conservas Marineras del Cantábrico | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades y con una horquilla muy amplia (600-2500), lo que impide presupuestar directamente. | «Material promocional para apoyar el lanzamiento» |
| v1 · feria-ejemplo · r1 | Envases y Bolsas Garrido | NEXT_ACTION_QUALITY | 2 | Propósito y productos claros, pero sin desglose de unidades por producto, lo que dificulta presupuestar directamente. | «Artículos de merchandising complementarios a su catálogo» |
| v1 · feria-ejemplo · r1 | Conservas Marineras del Cantábrico | COMMERCIAL_RELEVANCE | 4 | Encaje claro y específico. La necesidad se basa en los datos concretos del expositor (nueva línea de ventresca, 5 comerciales) y la confianza (0.88) está bien calibrada. | «Material promocional para apoyar el lanzamiento de la nueva línea de ventresca gourmet» |
| v1 · feria-ejemplo · r1 | Envases y Bolsas Garrido | COMMERCIAL_RELEVANCE | 0 | El expositor es un competidor directo parcial ('ofrece impresión de bolsas promocionales'), lo que va en contra del encaje evidente según el contexto de negocio. | «presenta dudas por ser parcialmente competidora al ofrecer bolsas promocionales» |
| v3 · feria-ejemplo · r1 | Conservas Marineras del Cantábrico | NEXT_ACTION_QUALITY | 4 | Desglose claro de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. El comercial puede presupuestar ya. | «Unas 400 bolsas de algodón personalizadas» |
| v3 · feria-ejemplo · r1 | Envases y Bolsas Garrido | NEXT_ACTION_QUALITY | 4 | Desglose de unidades por producto, presupuesto coherente, motivo ligado al evento y diferencial pertinente. Totalmente accionable. | «Unas 200 libretas con bolígrafo para entregar» |
| v3 · feria-ejemplo · r1 | Conservas Marineras del Cantábrico | COMMERCIAL_RELEVANCE | 4 | Encaje claro y específico basado en los datos del expositor (lanzamiento de producto, 5 comerciales). La confianza (0.88) es coherente con la información detallada. | «15 delantales o polos bordados para los 5 comerciales (3 mudas por persona)» |
| v3 · feria-ejemplo · r1 | Envases y Bolsas Garrido | COMMERCIAL_RELEVANCE | 0 | El expositor es un competidor directo parcial ('imprimir bolsas promocionales'), lo que va en contra del encaje evidente según el contexto de negocio. | «Es un distribuidor de envases que compite parcialmente al imprimir bolsas promocionales» |

#### Llamadas al juez

| Evaluador | Grupo | Modelo servido | Casos | Intentos | Tokens entrada / salida | Coste |
|---|---|---|---|---|---|---|
| `judge.next_action_quality@1` | v3+v1 | gemini-3.1-pro-preview | 20 | 1 | 8308 / 1600 | 0,0308 € |
| `judge.commercial_relevance@1` | v1+v3 | gemini-3.1-pro-preview | 20 | 1 | 8300 / 1790 | 0,0327 € |
