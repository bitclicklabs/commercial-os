## skill:compare prospector-event-exhibitors v1 vs v2

Coste total: 0.0903 € de 0.15 €. Escrituras en el CRM en memoria (FakeTwenty): 8; en Twenty real: 0.

Fixture: `test/fixtures/feria-ejemplo.json`

### Comparación v1 vs v2 — `prospector-event-exhibitors`

- Entrada: Expo Alimentaria Ibérica 2026, 3 expositores, 2 repetición(es) por versión. Hash de la entrada: `c38e913484f371f4`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-07. CRM: FakeTwenty (en memoria).
- Coste total: 0,0232 € de un presupuesto de 0,1500 €.

| Métrica | v1 | v2 |
|---|---|---|
| Decisiones (errores) | 6 (0) | 6 (0) |
| Relevantes | 4 | 4 |
| Escribibles (confianza ≥ umbral) | 2 | 2 |
| Confianza media (todas las decisiones) | 0,47 | 0,61 |
| Confianza media (solo relevantes) | 0,68 | 0,66 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 1 |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,68 / 0,90 (n=4) | 0,66 / 0,88 (n=4) |
| Hipótesis | 4 | 4 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 300-1000 u / 1200-4000 € (×1) | 515-800 u / 1450-2500 € (×1) |
| Amplitud media cantidad (máx./mín.) | 3,33 | 1,87 |
| Hipótesis con amplitud > 2,5 | 4 | 0 |
| «need» con cantidades | 0/4 | 4/4 |
| Precio unitario implícito en 0,50-15 € | 4/4 | 4/4 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 10038 / 1433 | 11496 / 1461 |
| Coste (por decisión) | 0,0111 € (0,0018 €) | 0,0121 € (0,0020 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,155 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v1: rel. · conf. | v2: rel. · conf. | Δ conf. | v1: cantidad · presupuesto | v2: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Conservas Marineras del Cantábrico | rich | 2/2 · 0,90 / 0,90 | 2/2 · 0,85 / 0,88 | -0,04 | 300-1000 u · 1200-3500 € | 500-900 u · 1400-2800 € |
| Envases y Bolsas Garrido | rich | 2/2 · 0,45 / 0,45 | 2/2 · 0,45 / 0,45 | 0,00 | 150-500 u · 300-1200 € | 208-450 u · 380-850 € |
| Instituto Regional de Promoción Agroalimentaria | rich | 0/2 · 0,05 / 0,05 | 0/2 · 0,95 / 0,05 | 0,45 | — | — |

#### Necesidad y razón (última repetición válida)

- **Conservas Marineras del Cantábrico** (rich)
  - v1 · razón: Empresa privada consolidada con 140 empleados, stand amplio de 60 m² y presentación de una nueva línea de producto, lo que asegura necesidad de merchandising tanto para visitantes como para su equipo.
  - v1 · need: Material promocional para el lanzamiento de su nueva línea de ventresca gourmet y dotación de textil corporativo para los cinco comerciales en el stand. · productos: Bolsas tote de algodón personalizadas, Delantales o polos bordados para el equipo comercial, Libretas y bolígrafos corporativos, Abridores o cubiertos gourmet de regalo · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v2 · razón: Empresa privada de tamaño relevante (140 empleados) con stand de 60 m² y lanzamiento de producto confirmado. Perfil ideal para merchandising de imagen, textil de equipo y soporte para muestras.
  - v2 · need: Unas 400 bolsas de algodón personalizadas para entregar muestras y catálogos de la nueva línea, 15 delantales o polos bordados para los 5 comerciales durante las jornadas, y 250 abridores o detalles gourmet para compradores clave. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina bordados, Polos técnicos bordados, Abridores multifunción grabados en láser, Libretas con bolígrafo para reuniones B2B · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Envases y Bolsas Garrido** (rich)
  - v1 · razón: Empresa privada en feria con stand compartido, pero solapa parcialmente como competidor al imprimir bolsas promocionales. Se califica con confianza baja por ser un caso dudoso.
  - v1 · need: Artículos promocionales complementarios que no produzcan internamente (como bolígrafos, libretas o textil corporativo para su equipo) para repartir en su stand. · productos: Bolígrafos personalizados, Libretas corporativas, Lanyards, Polos bordados para el personal del stand · THIS_QUARTER · TALLER_PROPIO, PRECIO, TRATO_CERCANO
  - v2 · razón: Empresa privada con stand compartido en feria, pero al ofrecer impresión de bolsas promocionales actúa como competidor parcial, lo que reduce la confianza.
  - v2 · need: Unas 200 libretas y bolígrafos para visitantes del stand y 8 lanyards o polos identificativos para su personal. · productos: Bolígrafos personalizados, Libretas corporativas, Lanyards, Polos bordados · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO
- **Instituto Regional de Promoción Agroalimentaria** (rich)
  - v1 · razón: Se trata de un organismo público autonómico cuyas compras se realizan mediante licitación pública, quedando fuera del circuito comercial directo de PubliEXPE.
  - v2 · razón: Se trata de un organismo público autonómico cuyas compras se gestionan mediante licitación pública, quedando fuera del circuito comercial directo de PubliEXPE.

Fixture: `test/fixtures/gastronoma-holdout.json`

### Comparación v1 vs v2 — `prospector-event-exhibitors`

- Entrada: Gastrónoma 2026, 8 expositores, 2 repetición(es) por versión. Hash de la entrada: `ab3862c07a06744e`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-07. CRM: FakeTwenty (en memoria).
- Coste total: 0,0671 € de un presupuesto de 0,1500 €.

| Métrica | v1 | v2 |
|---|---|---|
| Decisiones (errores) | 16 (0) | 16 (0) |
| Relevantes | 14 | 14 |
| Escribibles (confianza ≥ umbral) | 12 | 12 |
| Confianza media (todas las decisiones) | 0,60 | 0,59 |
| Confianza media (solo relevantes) | 0,68 | 0,60 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 1 |
| Relevantes: confianza media / máx. (solo nombre) | 0,68 / 0,85 (n=12) | 0,60 / 0,85 (n=12) |
| Relevantes: confianza media / máx. (nombre + sector) | 0,68 / 0,70 (n=2) | 0,65 / 0,65 (n=2) |
| Hipótesis | 14 | 14 |
| Rangos distintos / hipótesis | 0,93 | 1,00 |
| Rango más repetido | 250-800 u / 600-2200 € (×2) | 920-1500 u / 1250-2500 € (×1) |
| Amplitud media cantidad (máx./mín.) | 3,69 | 1,80 |
| Hipótesis con amplitud > 2,5 | 14 | 0 |
| «need» con cantidades | 0/14 | 14/14 |
| Precio unitario implícito en 0,50-15 € | 14/14 | 14/14 |
| Solo nombre: la razón marca la suposición | 2/12 | 8/12 |
| Tokens de entrada / salida | 25996 / 4749 | 29874 / 4885 |
| Coste (por decisión) | 0,0321 € (0,0020 €) | 0,0350 € (0,0022 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,016 | 0,059 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v1: rel. · conf. | v2: rel. · conf. | Δ conf. | v1: cantidad · presupuesto | v2: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| MUÑOZ BOSCH S.L. | name_only | 2/2 · 0,75 / 0,85 | 2/2 · 0,60 / 0,60 | -0,20 | 300-1200 u · 1200-4500 € | 715-1200 u · 1400-2800 € |
| ORIENTE EXQUISITO | sector | 2/2 · 0,65 / 0,70 | 2/2 · 0,65 / 0,65 | -0,03 | 250-1000 u · 600-2200 € | 260-500 u · 650-1350 € |
| QANTIMA GROUP | name_only | 2/2 · 0,70 / 0,70 | 2/2 · 0,60 / 0,55 | -0,13 | 250-1000 u · 750-2800 € | 460-750 u · 950-1850 € |
| REY JAYÓN | name_only | 2/2 · 0,55 / 0,65 | 2/2 · 0,55 / 0,55 | -0,05 | 250-800 u · 600-2200 € | 560-1200 u · 650-1400 € |
| STEEL-INOX, S.L. | name_only | 2/2 · 0,65 / 0,65 | 2/2 · 0,55 / 0,55 | -0,10 | 150-500 u · 600-2200 € | 210-350 u · 550-1100 € |
| UNIFORMES SANTA BÁRBARA | name_only | 2/2 · 0,45 / 0,45 | 2/2 · 0,45 / 0,45 | 0,00 | 200-600 u · 350-1200 € | 450-750 u · 600-1250 € |
| VICENTE GANDIA PLA, S.A. | name_only | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 300-1500 u · 900-3500 € | 725-1500 u · 1800-3800 € |
| XUNTA DE GALICIA | sector | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,95 | 0,45 | — | — |

#### Necesidad y razón (última repetición válida)

- **MUÑOZ BOSCH S.L.** (name_only)
  - v1 · razón: Muñoz Bosch es un distribuidor consolidado de equipamiento y suministros para hostelería y colectividades, expositor idóneo para Gastrónoma. Necesitarán material textil corporativo y detalles promocionales para clientes del sector horeca.
  - v1 · need: Equipamiento textil para su equipo comercial en el stand y regalos promocionales útiles para profesionales de la hostelería que visiten su espacio. · productos: delantales personalizados, polos bordados para personal de stand, libretas con bolígrafo, bolsas tote de algodón, sacacorchos promocionales · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v2 · razón: Muñoz Bosch es una empresa privada conocida en el sector de suministros de hostelería que expone en Gastrónoma. Al recibir únicamente el nombre, la confianza se sitúa en 0,6 calculando necesidades para un stand mediano.
  - v2 · need: Unas 400 bolsas de tela personalizadas para catálogos y muestras en mano, 300 libretas con bolígrafo para clientes B2B de hostelería y 15 delantales o polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina bordados, Libretas con bolígrafo promocional, Polos técnicos bordados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **ORIENTE EXQUISITO** (sector)
  - v1 · razón: Empresa privada del sector alimentación que expone en Gastrónoma 2026, idónea para entregar merchandising promocional y packaging a visitantes y distribuidores.
  - v1 · need: Artículos de merchandising y textil para el personal del stand, además de bolsas y detalles promocionales para entregar muestras de producto a compradores del sector gastronómico. · productos: Bolsas tote de algodón personalizadas, Delantales bordados, Bolígrafos publicitarios, Libretas de notas personalizadas · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v2 · razón: Empresa privada del sector alimentación exponiendo en feria profesional, con necesidad habitual de material promocional y textil. Al contar solo con nombre y sector, se asume un stand mediano estándar y la confianza se mantiene contenida.
  - v2 · need: Unas 250 bolsas de tela personalizadas para degustaciones o muestras de producto y 10 delantales o polos bordados para el equipo del stand. · productos: Bolsas tote de algodón personalizadas, Delantales bordados para hostelería/degustación, Polos bordados, Libretas pequeñas con bolígrafo para pedidos · IMMEDIATE · TALLER_PROPIO, PRECIO, TRATO_CERCANO
- **QANTIMA GROUP** (name_only)
  - v1 · razón: Qantima Group es una empresa privada de distribución de bebidas espirituosas y productos gourmet que expone en Gastrónoma 2026. Al faltar detalles sobre el tamaño del stand, la confianza se sitúa en 0,7.
  - v1 · need: Material promocional para potenciar su imagen de marca en catas y degustaciones del stand, así como obsequios para distribuidores y hostelería. · productos: Bolsas tote de algodón personalizadas, Sacacorchos y abridores grabados con láser, Delantales de hostelería serigrafiados, Libretas y bolígrafos para notas de cata · IMMEDIATE · TALLER_PROPIO, PRECIO, TRATO_CERCANO
  - v2 · razón: Empresa privada expositora en Gastrónoma; por conocimiento general del sector suele operar como distribuidora/creadora de bebidas y destilados premium, pero al no disponer de descripción oficial se estima un stand estándar.
  - v2 · need: Unas 250 bolsas de tela serigrafiadas para catas y entrega de producto a distribuidores, 200 abridores/sacacorchos grabados y 10 delantales o polos bordados para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Sacacorchos y abridores grabados en láser, Delantales de hostelería personalizados, Polos bordados para equipo, Bolígrafos metálicos grabados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **REY JAYÓN** (name_only)
  - v1 · razón: Empresa del sector gastronómico exponiendo en Gastrónoma 2026; encaje claro para detalles de stand y textil para el personal, aunque se dispone únicamente del nombre comercial.
  - v1 · need: Artículos de regalo promocional para visitantes del stand y textil corporativo (como delantales o polos) para el personal durante Gastrónoma 2026. · productos: delantales personalizados, bolsas tote de algodón personalizadas, sacacorchos o abridores grabados, libretas con bolígrafo ecológico · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v2 · razón: Expositor privado en una feria gastronómica profesional, previsiblemente productor o distribuidor de alimentación, aunque solo disponemos de su nombre y el cálculo asume un stand estándar.
  - v2 · need: Unas 250 bolsas de tela personalizadas para degustaciones y catálogos, 300 bolígrafos y 10 delantales o polos bordados para el personal del stand. · productos: bolsas tote de algodón personalizadas, delantales bordados para hostelería, bolígrafos promocionales, polos bordados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **STEEL-INOX, S.L.** (name_only)
  - v1 · razón: Empresa privada de equipamiento o carpintería metálica en acero inoxidable para hostelería/gastronomía que expone en feria. Carecemos de detalles adicionales sobre el tamaño del stand, por lo que la confianza es moderada.
  - v1 · need: Material textil unificado para el equipo del stand y detalles promocionales útiles para atraer a profesionales del canal Horeca e instaladores. · productos: delantales personalizados, polos bordados para el equipo, bolsas tote de algodón, metros plegables o flexómetros personalizados, bolígrafos metálicos grabados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v2 · razón: Por el nombre, parece una empresa privada proveedora de equipamiento o mobiliario en acero inoxidable para hostelería; al no tener descripción detallada, se asume un stand de tamaño estándar y la confianza no supera 0,6.
  - v2 · need: Unas 200 libretas con bolígrafo para reuniones con clientes del sector horeca y 10 polos bordados para el personal del stand. · productos: Polos técnicos bordados, Libretas A5 con bolígrafo, Bolsas tote de algodón, Lanyards corporativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **UNIFORMES SANTA BÁRBARA** (name_only)
  - v1 · razón: Es una empresa privada especializada en uniformidad laboral (potencialmente competidora parcial en textil publicitario, pero cliente potencial de merchandising complementario). Falta información detallada y existe solapamiento parcial de actividad.
  - v1 · need: Regalos promocionales no textiles para obsequiar a visitantes y hosteleros que se acerquen a su stand en Gastrónoma 2026. · productos: bolígrafos metálicos grabados con láser, libretas de notas personalizadas, bolsas tote de algodón, lanyards personalizados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
  - v2 · razón: Por el nombre parece dedicarse al vestuario laboral, por lo que podría ser competidor parcial en textil, pero puede requerir merchandising complementario para la feria. Al disponer únicamente del nombre y existir riesgo de competencia, mantengo la confianza baja.
  - v2 · need: Unas 250 bolsas de tela serigrafiadas para entregar catálogos de uniformidad a visitantes y 200 bolígrafos corporativos de apoyo comercial en el stand. · productos: bolsas tote de algodón personalizadas, bolígrafos metálicos o de plástico personalizados, lanyards identificativos, libretas con logotipo · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **VICENTE GANDIA PLA, S.A.** (name_only)
  - v1 · razón: Vicente Gandía es una gran bodega valenciana con presencia destacada en ferias gastronómicas que requiere merchandising para degustaciones, clientes y canal Horeca.
  - v1 · need: Artículos de regalo corporativo y promocionales vinculados al mundo del vino y la gastronomía para fidelizar a profesionales del canal Horeca y obsequiar a visitantes del stand. · productos: Sacacorchos personalizados, Bolsas de tela para botellas, Lanyards e identificadores para el personal de stand, Copas o catavinos serigrafiados, Libretas de notas tipo sommelier · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v2 · razón: Por conocimiento general, Vicente Gandia es una bodega valenciana líder de gran tamaño y presencia comercial destacada, con encaje idóneo en Gastrónoma. Aunque los datos recibidos solo aportan la razón social, su notoriedad sectorial justifica superar el techo habitual de confianza.
  - v2 · need: Unas 500 bolsas de tela o non-woven para botellas/catálogo para visitantes profesionales, 200 sacacorchos personalizados para clientes VIP y 25 delantales o polos bordados para el personal del stand. · productos: Bolsas para botellas de vino de algodón o yute personalizadas, Sacacorchos y abridores grabados a láser, Delantales de sumiller bordados, Polos técnicos bordados para el equipo comercial, Libretas de notas con bolígrafo para catas · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **XUNTA DE GALICIA** (sector)
  - v1 · razón: Se trata de un organismo público autonómico (Xunta de Galicia) clasificado en el sector institucional, por lo que su contratación se realiza mediante licitaciones públicas y queda fuera del alcance comercial directo.
  - v2 · razón: Se trata de un organismo público autonómico (administración pública) cuyo aprovisionamiento se gestiona mediante licitación oficial, quedando fuera del circuito comercial directo de PubliEXPE.

