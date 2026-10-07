## skill:compare prospector-event-exhibitors v1 vs v3

Coste total: 0.1067 € de 0.15 €. Escrituras en el CRM en memoria (FakeTwenty): 8; en Twenty real: 0.

Fixture: `test/fixtures/organismos-publicos-sinteticos.json`

### Comparación v1 vs v3 — `prospector-event-exhibitors`

- Entrada: Expo Alimentaria Ibérica 2026, 2 expositores, 2 repetición(es) por versión. Hash de la entrada: `a5c9a330b56c7129`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-07. CRM: FakeTwenty (en memoria).
- Coste total: 0,0114 € de un presupuesto de 0,1500 €.

| Métrica | v1 | v3 |
|---|---|---|
| Decisiones (errores) | 4 (0) | 4 (0) |
| Relevantes | 0 | 0 |
| Escribibles (confianza ≥ umbral) | 0 | 0 |
| Confianza media (todas las decisiones) | 0,05 | 0,05 |
| Confianza media (solo relevantes) | — | — |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Hipótesis | 0 | 0 |
| Rangos distintos / hipótesis | — | — |
| Rango más repetido | — | — |
| Amplitud media cantidad (máx./mín.) | — | — |
| Hipótesis con amplitud > 2,5 | 0 | 0 |
| «need» con cantidades | 0/0 | 0/0 |
| Precio unitario implícito en 0,50-15 € | 0/0 | 0/0 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 6694 / 304 | 7932 / 296 |
| Coste (por decisión) | 0,0053 € (0,0013 €) | 0,0061 € (0,0015 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,000 | 0,000 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v1: rel. · conf. | v3: rel. · conf. | Δ conf. | v1: cantidad · presupuesto | v3: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| DIPUTACIÓN PROVINCIAL DE MONTEALTO | sector | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |
| Mercamontealto, Unidad Alimentaria de Montealto S.A. | rich | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |

#### Necesidad y razón (última repetición válida)

- **DIPUTACIÓN PROVINCIAL DE MONTEALTO** (sector)
  - v1 · razón: Se trata de un organismo público (Diputación Provincial) que gestiona sus compras mediante licitación oficial, quedando fuera del circuito comercial directo de PubliEXPE.
  - v3 · razón: Se trata de un organismo público (Diputación Provincial) que gestiona sus compras mediante licitaciones públicas oficiales, fuera del circuito comercial directo de PubliEXPE.
- **Mercamontealto, Unidad Alimentaria de Montealto S.A.** (rich)
  - v1 · razón: Se trata de una sociedad mercantil de capital íntegramente público que tramita sus compras mediante licitación pública sujeta a la LCSP. Por política de prospección, los organismos públicos quedan fuera del circuito comercial directo de PubliEXPE.
  - v3 · razón: Se trata de una empresa de capital íntegramente público que gestiona sus compras mediante licitación pública sujeta a la LCSP. Queda fuera del circuito de venta comercial directa de PubliEXPE.

Fixture: `test/fixtures/gastronoma-holdout-2.json`

### Comparación v1 vs v3 — `prospector-event-exhibitors`

- Entrada: Gastrónoma 2026, 8 expositores, 2 repetición(es) por versión. Hash de la entrada: `2d1b2a463ec8a838`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-07. CRM: FakeTwenty (en memoria).
- Coste total: 0,0717 € de un presupuesto de 0,1500 €.

| Métrica | v1 | v3 |
|---|---|---|
| Decisiones (errores) | 16 (0) | 16 (0) |
| Relevantes | 16 | 16 |
| Escribibles (confianza ≥ umbral) | 16 | 16 |
| Confianza media (todas las decisiones) | 0,73 | 0,64 |
| Confianza media (solo relevantes) | 0,73 | 0,64 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (solo nombre) | 0,67 / 0,75 (n=10) | 0,55 / 0,58 (n=10) |
| Relevantes: confianza media / máx. (nombre + sector) | 0,82 / 0,85 (n=6) | 0,79 / 0,85 (n=6) |
| Hipótesis | 16 | 16 |
| Rangos distintos / hipótesis | 0,88 | 1,00 |
| Rango más repetido | 250-1000 u / 600-2200 € (×3) | 260-500 u / 550-1200 € (×1) |
| Amplitud media cantidad (máx./mín.) | 3,70 | 1,76 |
| Hipótesis con amplitud > 2,5 | 16 | 0 |
| «need» con cantidades | 0/16 | 16/16 |
| Precio unitario implícito en 0,50-15 € | 16/16 | 16/16 |
| Solo nombre: la razón marca la suposición | 0/10 | 9/10 |
| Tokens de entrada / salida | 26002 / 5393 | 30974 / 5434 |
| Coste (por decisión) | 0,0342 € (0,0021 €) | 0,0375 € (0,0023 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,006 | 0,005 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v1: rel. · conf. | v3: rel. · conf. | Δ conf. | v1: cantidad · presupuesto | v3: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| MYBAOS SL | name_only | 2/2 · 0,65 / 0,65 | 2/2 · 0,55 / 0,55 | -0,10 | 150-600 u · 500-2200 € | 260-500 u · 580-1250 € |
| PREZO | name_only | 2/2 · 0,70 / 0,65 | 2/2 · 0,55 / 0,55 | -0,13 | 300-800 u · 600-1800 € | 260-500 u · 650-1400 € |
| QBO DELICIAS SL | name_only | 2/2 · 0,65 / 0,65 | 2/2 · 0,55 / 0,55 | -0,10 | 250-800 u · 600-1800 € | 350-600 u · 650-1400 € |
| SERHS PROJECTS | name_only | 2/2 · 0,75 / 0,70 | 2/2 · 0,55 / 0,58 | -0,16 | 250-800 u · 850-2600 € | 465-750 u · 1100-2200 € |
| TEMPLO CAFÉS | sector | 2/2 · 0,85 / 0,85 | 2/2 · 0,80 / 0,85 | -0,03 | 300-1200 u · 1200-4500 € | 700-1020 u · 2100-3800 € |
| UNOX | sector | 2/2 · 0,85 / 0,85 | 2/2 · 0,85 / 0,85 | 0,00 | 300-1000 u · 900-3500 € | 720-1200 u · 1800-3200 € |
| VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO | sector | 2/2 · 0,75 / 0,75 | 2/2 · 0,70 / 0,70 | -0,05 | 250-1000 u · 600-2500 € | 410-650 u · 850-1600 € |
| ZERO,O MIXERS | name_only | 2/2 · 0,65 / 0,65 | 2/2 · 0,55 / 0,55 | -0,10 | 250-800 u · 600-2200 € | 465-900 u · 850-1800 € |

#### Necesidad y razón (última repetición válida)

- **MYBAOS SL** (name_only)
  - v1 · razón: Empresa privada del sector gastronómico exponiendo en Gastrónoma 2026, lo que implica necesidad de merchandising y textil para el stand. La confianza es moderada debido a la falta de datos adicionales sobre el tamaño específico de la compañía.
  - v1 · need: Prendas de vestir personalizadas para el personal del stand (delantales o camisetas) y regalos promocionales para atraer visitantes y distribuidores del sector hostelero. · productos: delantales personalizados, camisetas de algodón serigrafiadas, bolsas tote de algodón, libretas de notas con bolígrafo · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Empresa privada expositora en Gastrónoma 2026; por el nombre parece vinculada a hostelería/alimentación (baos), pero solo disponemos de la razón social, por lo que calculamos para un stand pequeño.
  - v3 · need: Unas 250 bolsas tote de algodón para repartir a visitantes y compradores, junto con 10 delantales o camisetas personalizadas para el personal del stand. · productos: Bolsas tote de algodón personalizadas, Delantales personalizados para cocina/degustación, Camisetas serigrafiadas, Lanyards identificativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **PREZO** (name_only)
  - v1 · razón: Prezo es una plataforma de software de gestión de compras y pedidos para hostelería que expone en Gastrónoma para captar restaurantes. Al contar solo con el nombre en la ficha, la confianza es moderada pero el encaje en feria B2B es claro.
  - v1 · need: Artículos promocionales para captar la atención de hosteleros y gerentes de restaurantes en su stand, además de textil corporativo para los comerciales que hacen demos. · productos: Libretas personalizadas para hostelería, Bolígrafos metálicos o de bambú, Bolsas tote de algodón con logo, Polos técnicos bordados para el equipo comercial · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Empresa privada expositora en Gastrónoma 2026; por conocimiento general del sector horeca, Prezo es una plataforma de software de gestión de compras para hostelería, pero al recibir solo el nombre la confianza se mantiene prudente.
  - v3 · need: Unas 250 libretas con bolígrafo para captar contactos de hosteleros en demostraciones y 10 camisetas corporativas para el personal del stand. · productos: libretas personalizadas, bolígrafos metálicos o ecológicos, camisetas corporativas, lanyards identificativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **QBO DELICIAS SL** (name_only)
  - v1 · razón: Empresa privada del sector de la alimentación que expone en Gastrónoma 2026, lo que implica necesidad de merchandising promocional e indumentaria para el stand, aunque faltan detalles específicos sobre su tamaño.
  - v1 · need: Artículos de regalo para visitantes del stand y distribuidores gastronómicos, además de textil corporativo para el personal de atención y degustación. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina personalizados, Bolígrafos promocionales, Libretas con logo · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Por el nombre y su presencia en Gastrónoma, parece una empresa privada del sector agroalimentario o restauración. Solo disponemos del nombre, por lo que estimamos necesidades para un stand pequeño o mediano.
  - v3 · need: Unas 300 bolsas de tela o non-woven para entregar catálogos/muestras en el stand, 10 delantales o polos bordados para el equipo y 200 abridores o libretas promocionales. · productos: bolsas tote de algodón personalizadas, delantales personalizados, polos bordados, abridores metálicos personalizados, libretas con bolígrafo · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **SERHS PROJECTS** (name_only)
  - v1 · razón: SERHS Projects es una división especializada en proyectos e instalaciones de hostelería del Grupo SERHS, con perfil B2B idóneo para Gastrónoma. Aunque faltan detalles específicos sobre el tamaño del stand, su presencia comercial justifica material promocional corporativo.
  - v1 · need: Material promocional para captación y fidelización de profesionales del sector hostelero (restauración y hoteles) que visiten su stand en Gastrónoma 2026, además de indumentaria corporativa para el equipo comercial. · productos: Libretas corporativas con bolígrafo, Bolsas tote de algodón personalizadas, Polos técnicos bordados para el equipo comercial, Memorias USB o tarjetas USB con catálogo técnico, Botellas térmicas reutilizables · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Por el nombre y el evento Gastrónoma, suponemos que es la división de equipamiento y proyectos para hostelería de Grup SERHS, empresa privada idónea para merchandising técnico y de stand. Al recibir solo el nombre sin descripción ni web, aplicamos un límite de confianza.
  - v3 · need: Unas 250 libretas con bolígrafo para reuniones con hosteleros y proyectistas, 200 metros de lanyards con acreditaciones y 15 camisas o polos bordados para el equipo comercial del stand. · productos: libretas con bolígrafo personalizadas, polos bordados para personal, lanyards personalizados, bolsas tote de algodón · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO
- **TEMPLO CAFÉS** (sector)
  - v1 · razón: Empresa consolidada del sector hostelero y alimentación exponiendo en una feria gastronómica relevante. Requieren obsequios para profesionales de hostelería y textil corporativo para su equipo en el stand.
  - v1 · need: Artículos promocionales para hostelería (tazas térmicas, delantales y bolsas) y textil corporativo para el personal del stand para reforzar marca en degustaciones y reuniones con clientes. · productos: delantales personalizados, tazas térmicas para café, bolsas tote de algodón, libretas con bolígrafo para pedidos, camisetas o polos bordados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Templo Cafés es una marca líder muy consolidada en el sector horeca y alimentación, conocida por su amplia presencia en ferias profesionales. Al ser una empresa de gran tamaño con alto volumen de distribución, encaja perfectamente en compras recurrentes de merchandising.
  - v3 · need: Unas 400 tazas térmicas o de cerámica personalizadas para degustaciones y clientes clave, 600 bolsas de algodón para catálogos y 20 delantales o polos bordados para el equipo del stand. · productos: Tazas de cerámica personalizadas, Vasos térmicos reutilizables, Delantales de barista bordados, Bolsas tote de algodón orgánico, Polos corporativos bordados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **UNOX** (sector)
  - v1 · razón: UNOX es un fabricante líder internacional de hornos profesionales para hostelería con presencia comercial destacada y stand relevante en ferias del sector.
  - v1 · need: Material promocional para profesionales de hostelería y distribuidores que visiten el stand, además de textil corporativo para su equipo comercial y técnico. · productos: delantales personalizados, libretas con bolígrafo, bolsas tote de algodón, polos bordados para equipo, memorias USB o lanyards · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: UNOX es un fabricante multinacional líder de hornos profesionales muy consolidado en hostelería, con gran presencia habitual en ferias del sector gastronómico (conocimiento general del sector).
  - v3 · need: Unas 400 bolsas de tela para catálogos y visitantes, 20 delantales o chaquetillas técnicas personalizadas para demostraciones en directo de sus hornos, y 300 libretas con bolígrafo para reuniones con distribuidores. · productos: delantales bordados para hostelería, bolsas tote de algodón personalizadas, libretas con bolígrafo, lanyards identificativos · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **VINO CAÑAS Y BARRO - VIÑAS DEL PORTILLO** (sector)
  - v1 · razón: Bodega privada exponiendo en feria gastronómica relevante, con necesidad habitual de merchandising para degustaciones y obsequios comerciales. La cercanía del evento exige plazos rápidos.
  - v1 · need: Artículos promocionales para visitantes del stand y clientes de hostelería o distribución, tales como accesorios de vino personalizados y bolsas de tela para botellas o catálogos. · productos: Sacacorchos de dos tiempos personalizados, Bolsas tote de algodón o yute para botellas, Identificadores o copas serigrafiadas, Delantales bordados para el personal del stand, Bolígrafos metálicos grabados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Bodega privada exponiendo en Gastrónoma con necesidad directa de merchandising y textil para el stand; al disponer solo de nombre y sector, se dimensiona como stand estándar de bodega.
  - v3 · need: Unas 250 bolsas tote de algodón para botellas o catálogos, 10 delantales o polos bordados para el personal de cata y 150 sacacorchos personalizados para obsequio a distribuidores. · productos: Bolsas tote de algodón personalizadas, Delantales o polos bordados, Sacacorchos sommelier grabados, Libretas de notas con bolígrafo · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **ZERO,O MIXERS** (name_only)
  - v1 · razón: Empresa privada del sector de bebidas/mixers exponiendo en Gastrónoma, ideal para obsequios promocionales y textil para su stand. La información disponible sobre el expositor es limitada pero suficiente para deducir su encaje comercial.
  - v1 · need: Material promocional para degustaciones y obsequios a clientes del canal HORECA, además de textil corporativo para el personal en feria. · productos: Abridores y sacacorchos personalizados, Vasos reutilizables serigrafiados, Delantales o polos bordados para el personal, Bolsas tote de algodón con logo · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Por el nombre, parece una marca privada de bebidas o mixers para hostelería exponiendo en Gastrónoma, aunque al disponer solo del nombre la confianza se sitúa en un techo prudente y se estima un stand mediano.
  - v3 · need: Unas 300 bolsas de tela serigrafiadas para catas y folletos a visitantes, 15 delantales o camisetas personalizadas para el personal de servicio y 150 abridores de botellas publicitarios. · productos: bolsas tote de algodón personalizadas, camisetas o polos bordados, delantales personalizados, abridores de botellas promocionales, vasos reutilizables serigrafiados · IMMEDIATE · TALLER_PROPIO, TRATO_CERCANO, PRECIO

Fixture: `test/fixtures/feria-ejemplo.json`

### Comparación v1 vs v3 — `prospector-event-exhibitors`

- Entrada: Expo Alimentaria Ibérica 2026, 3 expositores, 2 repetición(es) por versión. Hash de la entrada: `c38e913484f371f4`.
- Modelo: `gemini-flash-latest`. Fecha que ve el agente: 2026-10-07. CRM: FakeTwenty (en memoria).
- Coste total: 0,0237 € de un presupuesto de 0,1500 €.

| Métrica | v1 | v3 |
|---|---|---|
| Decisiones (errores) | 6 (0) | 6 (0) |
| Relevantes | 4 | 4 |
| Escribibles (confianza ≥ umbral) | 2 | 2 |
| Confianza media (todas las decisiones) | 0,46 | 0,46 |
| Confianza media (solo relevantes) | 0,67 | 0,67 |
| No relevantes con confianza > 0,19 (incoherencia) | 0 | 0 |
| Relevantes: confianza media / máx. (descripción o dominio) | 0,67 / 0,90 (n=4) | 0,67 / 0,88 (n=4) |
| Hipótesis | 4 | 4 |
| Rangos distintos / hipótesis | 1,00 | 1,00 |
| Rango más repetido | 600-2500 u / 1200-4500 € (×1) | 615-1000 u / 1800-3500 € (×1) |
| Amplitud media cantidad (máx./mín.) | 3,71 | 1,82 |
| Hipótesis con amplitud > 2,5 | 4 | 0 |
| «need» con cantidades | 0/4 | 4/4 |
| Precio unitario implícito en 0,50-15 € | 4/4 | 4/4 |
| Solo nombre: la razón marca la suposición | 0/0 | 0/0 |
| Tokens de entrada / salida | 10040 / 1440 | 11898 / 1507 |
| Coste (por decisión) | 0,0111 € (0,0019 €) | 0,0125 € (0,0021 €) |
| Estabilidad entre repeticiones: desviación media de la confianza | 0,003 | 0,000 |
| Estabilidad: expositores que cambian relevante / escribible | 0 / 0 | 0 / 0 |

#### Lado a lado por expositor

| Expositor | Datos | v1: rel. · conf. | v3: rel. · conf. | Δ conf. | v1: cantidad · presupuesto | v3: cantidad · presupuesto |
|---|---|---|---|---|---|---|
| Conservas Marineras del Cantábrico | rich | 2/2 · 0,88 / 0,90 | 2/2 · 0,88 / 0,88 | -0,01 | 500-2500 u · 1200-4500 € | 720-1200 u · 1800-3500 € |
| Envases y Bolsas Garrido | rich | 2/2 · 0,45 / 0,45 | 2/2 · 0,45 / 0,45 | 0,00 | 150-400 u · 350-1200 € | 206-412 u · 380-850 € |
| Instituto Regional de Promoción Agroalimentaria | rich | 0/2 · 0,05 / 0,05 | 0/2 · 0,05 / 0,05 | 0,00 | — | — |

#### Necesidad y razón (última repetición válida)

- **Conservas Marineras del Cantábrico** (rich)
  - v1 · razón: Empresa privada de tamaño relevante (140 empleados) con presencia destacada de 60 m² y lanzamiento de producto nuevo en feria. Tienen necesidad clara de material corporativo y regalos para visitantes y distribuidores.
  - v1 · need: Merchandising promocional para visitantes del stand y packaging o detalles premium para apoyar el lanzamiento de su nueva línea de ventresca, además de uniformidad para sus cinco comerciales. · productos: Bolsas tote de algodón personalizadas, Delantales de cocina bordados, Polos bordados para comerciales, Bolígrafos metálicos grabados, Abrelatas o accesorios gourmet personalizados · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
  - v3 · razón: Empresa privada consolidada de 140 empleados con presencia destacada (stand de 60 m² y 5 comerciales) y lanzamiento de producto confirmado. Encaje comercial óptimo para merchandising promocional y textil corporativo.
  - v3 · need: Unas 400 bolsas de algodón para entregar muestras del lanzamiento de ventresca, 20 polos o delantales bordados para el equipo comercial y 300 abridores o detalles gourmet para compradores clave. · productos: bolsas tote de algodón personalizadas, polos bordados, delantales corporativos, abridores multiusos personalizados, libretas con bolígrafo para notas de cata · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Envases y Bolsas Garrido** (rich)
  - v1 · razón: Es un distribuidor de envases en stand compartido que además imprime bolsas promocionales, por lo que es un competidor parcial y el encaje comercial es dudoso.
  - v1 · need: Artículos de merchandising corporativo para su equipo comercial y detalles de cortesía para clientes HORECA que visiten su stand, complementando su oferta sin solaparse con las bolsas que ellos mismos imprimen. · productos: Polos técnicos bordados para el equipo comercial, Lanyards e identificadores personalizados, Bolígrafos metálicos grabados con láser, Libretas corporativas con soporte para bolígrafo · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO
  - v3 · razón: Empresa privada de packaging que expone en stand compartido, pero supone un caso dudoso al ofrecer también impresión de bolsas promocionales (competidor parcial). Asumimos stand pequeño y requerimientos limitados.
  - v3 · need: Unas 200 libretas y bolígrafos para clientes HORECA que visiten el stand, y 6 polos bordados para el personal comercial. · productos: bolígrafos metálicos grabados, libretas personalizadas con soporte para bolígrafo, polos bordados corporativos, lanyards identificativos · THIS_QUARTER · TALLER_PROPIO, TRATO_CERCANO, PRECIO
- **Instituto Regional de Promoción Agroalimentaria** (rich)
  - v1 · razón: Se trata de un organismo público autonómico cuyas compras se gestionan mediante licitación pública, quedando fuera del circuito comercial directo de PubliEXPE.
  - v3 · razón: Se trata de un organismo público autonómico cuyas compras se tramitan por licitación pública, quedando fuera del circuito comercial directo de PubliEXPE.

