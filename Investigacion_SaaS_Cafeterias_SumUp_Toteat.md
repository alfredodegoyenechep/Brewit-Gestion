# Oportunidad SaaS para la gestión de cafeterías

Investigación de SumUp y Toteat y playbook de producto e integración

Preparado para Alfredo De Goyeneche y Brewit. Investigación documental al 17 de septiembre de 2026.

## 1 Decisión recomendada

**Sí existe una oportunidad plausible para crear un SaaS complementario, pero todavía no hay evidencia suficiente para afirmar que existe un mercado desatendido masivo ni que los cuatro millones de comercios de SumUp sean clientes alcanzables.** Recomiendo avanzar con un producto especializado en control de rentabilidad y operación de cafeterías, validar primero sobre Toteat y condicionar la expansión a SumUp a una prueba del acceso a sus datos comerciales, por producto y país.

La hipótesis inicial necesita tres correcciones:

- **Toteat sí tiene gestión de ingredientes, recetas, subrecetas, producción, bodegas, proveedores y compras.** Su academia documenta estos procesos. La experiencia de Brewit puede mostrar problemas de calidad, integración o facilidad de uso, pero no demuestra ausencia funcional. [S01](https://learning.toteat.com/product/introduccion-a-inventarios-toteat)
- **SumUp no es una única aplicación global.** Hay pagos, aplicaciones POS actuales y plataformas con historia y APIs distintas. Goodtill documenta ingredientes, modificadores, producción, compras, mermas y diferencias de inventario. Esas prestaciones no pueden atribuirse automáticamente a la oferta chilena. [S02](https://support.thegoodtill.com/modules) [S03](https://support.thegoodtill.com/ingredientsetup) [S04](https://support.thegoodtill.com/support/production-events) [S05](https://support.thegoodtill.com/advanced-stock-purchase-orders)
- **Los complementos ya existen.** MarketMan, KitchenCUT, Apicbase y Tenzo ocupan partes del espacio. Una aplicación que solo agregue recetas, stock y gráficos competiría en una categoría existente. [S06](https://www.marketman.com/partner/sumup) [S07](https://support.thegoodtill.com/support/kitchencut) [S08](https://partners.apicbase.com/integrations/goodtill) [S09](https://www.gotenzo.com/integration/sumup/)

La oportunidad que propongo validar es esta: **ayudar al dueño de una cafetería o pequeña cadena a saber cuánto gana, por qué cambia su margen y qué debe hacer hoy, manteniendo sus datos operativos correctos con el menor trabajo posible.** La propuesta debe unir compras, recetas, consumo, conteos y decisiones, y funcionar aunque el POS cambie.

**Prioridad comercial sugerida:** cafeterías y pequeñas cadenas de 2 a 20 locales; incluir locales únicos de suficiente volumen como grupo de comparación. El número de locales es una hipótesis de segmentación, no un dato de mercado. Dejar para después restaurantes con cocina compleja, hoteles, grandes franquicias y comercios sin preparación de alimentos.

**Decisión de inversión:** financiar una validación de 90 días y un producto acotado; no financiar todavía una suite universal ni basar el caso de negocio en capturar un porcentaje arbitrario de SumUp.

### Hallazgos que cambian el proyecto

| Hallazgo | Consecuencia para el negocio |
|---|---|
| El POS chileno de SumUp anuncia inventario, catálogo, caja y reportes | Hay que demostrar una mejora frente al producto actual, no frente a una versión antigua [S10](https://www.sumup.com/es-cl/punto-de-venta/) [S11](https://www.sumup.com/es-cl/tipos-de-negocios/cafeterias/) |
| Goodtill tiene back office y ecosistema desarrollado | Mayor viabilidad técnica, pero competencia directa y necesidad de confirmar continuidad [S02](https://support.thegoodtill.com/modules) [S03](https://support.thegoodtill.com/ingredientsetup) [S04](https://support.thegoodtill.com/support/production-events) [S05](https://support.thegoodtill.com/advanced-stock-purchase-orders) [S12](https://support.thegoodtill.com/support/api) |
| Tiller y POS Pro V3 anuncian retiro del producto hacia fines de 2026 y no aceptan nuevas integraciones | No iniciar un conector nuevo allí sin una ruta autorizada de migración [S13](https://tiller-api.readme.io/) [S14](https://tillersystems-v3.readme.io/reference/introduction-1) |
| Toteat publica APIs de ventas, inventario, compras y webhooks | Hay una base técnica documentada para un complemento sustantivo [S15](https://developers.toteat.com/) |
| La API de pagos de SumUp no equivale a una API completa de restaurante | Cobros y abonos no bastan para descontar recetas por venta [S16](https://developer.sumup.com/api/transactions) [S17](https://github.com/sumup/sumup-developer/blob/main/openapi.json) |
| La integración MarketMan con SumUp indica USA, UK y Australia | No se puede vender como un add-on confirmado para SumUp Chile [S06](https://www.marketman.com/partner/sumup) |

## 2 Alcance y calidad de la evidencia

Se revisaron páginas de producto, documentación de soporte, guías de integraciones, precios y especificaciones técnicas públicas. Se descargó y examinó el OpenAPI publicado por Toteat, sus archivos de rutas, esquemas y webhooks; también el OpenAPI público de SumUp. No se accedió a cuentas de comercios, bases de datos privadas, contratos de partnership ni al código de la aplicación existente de Brewit.

Este informe distingue cuatro niveles:

| Nivel | Qué permite afirmar | Qué no permite afirmar |
|---|---|---|
| Documentación técnica | Existe una interfaz o un comportamiento descrito | Que funcione igual para todo comercio o versión |
| Manual operativo | El producto documenta un flujo concreto | Que sea fácil, rápido o confiable en uso cotidiano |
| Declaración comercial | El proveedor ofrece una capacidad o integración | Su profundidad, SLA, disponibilidad local o ausencia de errores |
| Propuesta propia | Diseño, priorización y escenarios para el nuevo SaaS | Demanda probada, retorno garantizado o superioridad demostrada |

Las evaluaciones de madurez de este documento son juicios sobre profundidad documentada, no resultados de pruebas comparativas. **“No verificado” no significa “no existe”.** La información comercial cambia, y algunas fuentes oficiales son inconsistentes entre sí; esas inconsistencias se registran expresamente.

Los nombres “Totit” y “Sumato” se interpretan aquí como Toteat y SumUp, de acuerdo con el contexto del pedido.

## 3 Qué es realmente SumUp en este análisis

### Cinco superficies que conviene separar

| Superficie | Qué encontramos | Tratamiento recomendado |
|---|---|---|
| Pagos y cuenta de comercio | Terminales, cobros, transacciones y abonos | Conector financiero; no presuponer ticket detallado |
| POS y Smart POS Chile | Catálogo, variantes, inventario anunciado, caja y reportes | Mercado interesante; acceso a órdenes por API pendiente |
| Register y POS Plus UK | Oferta actual con ventas, stock y gestión de personal | Verificar API específica; no asumir compatibilidad Goodtill |
| SumUp POS sobre Goodtill | Manuales de recetas, producción, compras, stock y API de tienda | Posible conector independiente, sujeto a continuidad comercial |
| Tiller y POS Pro V3 | API de órdenes y eventos con aviso de retiro | No priorizar para un desarrollo nuevo |

Fuentes por familia: pagos [S16](https://developer.sumup.com/api/transactions) [S17](https://github.com/sumup/sumup-developer/blob/main/openapi.json) [S18](https://developer.sumup.com/tools/authorization/); Chile [S10](https://www.sumup.com/es-cl/punto-de-venta/) [S11](https://www.sumup.com/es-cl/tipos-de-negocios/cafeterias/); Register UK [S19](https://www.sumup.com/en-gb/pos-register/); Goodtill [S02](https://support.thegoodtill.com/modules) [S03](https://support.thegoodtill.com/ingredientsetup) [S04](https://support.thegoodtill.com/support/production-events) [S05](https://support.thegoodtill.com/advanced-stock-purchase-orders) [S12](https://support.thegoodtill.com/support/api); Tiller [S13](https://tiller-api.readme.io/) [S14](https://tillersystems-v3.readme.io/reference/introduction-1). Los nombres comerciales pueden solaparse; identificar la familia por dominio del back office, aplicación, país y documentación contractual.

En Chile, la oferta actual contradice la afirmación amplia de que SumUp no maneja inventario. Lo que **no quedó demostrado** es que la versión local cubra recetas multinivel, consumo por ingrediente y sustitución, compras con recepción parcial, costos históricos y trazabilidad de bodega con la profundidad que requiere este proyecto. La demo debe resolverlo con casos concretos. [S10](https://www.sumup.com/es-cl/punto-de-venta/) [S11](https://www.sumup.com/es-cl/tipos-de-negocios/cafeterias/)

El aviso de retiro de Tiller merece atención especial. Ambos portales consultados dicen que POS Pro dejará de estar disponible a fines de 2026, que no se aceptan nuevas integraciones y que se retomen consultas desde el segundo trimestre de 2027. La cabecera del portal antiguo contiene además una fecha de calendario imposible, 29 de febrero de 2027. Por ello se utiliza el aviso general como señal de riesgo y se requiere confirmación escrita del calendario. **No se extrapola ese retiro a todos los productos SumUp ni a Goodtill.** [S13](https://tiller-api.readme.io/) [S14](https://tillersystems-v3.readme.io/reference/introduction-1)

### Cuatro millones no equivalen al mercado del SaaS

SumUp declara más de cuatro millones de comercios globalmente. Esa cifra no identifica cuántos son cafeterías, cuántos usan un POS con detalle de productos, cuántos están activos, cuántos tienen datos accesibles por API ni cuántos pagarían otra suscripción. Tampoco significa cuatro millones de locales únicos disponibles mediante un canal comercial común. [S20](https://www.sumup.com/en-us/)

Para dimensionar la oportunidad se necesita esta secuencia: comercios de alimentación activos, países atendibles, familias POS compatibles, datos suficientes, problema relevante, presupuesto y canal de adquisición. Cada filtro reduce el universo. La base instalada es una señal de escala potencial, no una cartera comercial accesible.

## 4 Mapa de procesos de una cafetería

La matriz cubre el ciclo completo: planificación, abastecimiento, operación, venta, control y mejora. Se separa SumUp Chile de Goodtill porque mezclar ambas ofertas produciría una conclusión engañosa. Toteat se evalúa incluyendo sus módulos adicionales, no solo el plan básico.

**Leyenda:** D = documentado; P = cobertura parcial o profundidad por validar; A = módulo adicional o configuración; I = integración documentada; NV = no verificado en las fuentes revisadas. Las combinaciones no implican inclusión en todos los planes. Los números identifican procesos para las decisiones de producto posteriores.

### Planificación comercial y venta

| Proceso | SumUp Chile | Goodtill | Toteat | Complemento o decisión |
|---|---|---|---|---|
| 01 Catálogo y precios | D | D | D | Mantener el POS como maestro de venta |
| 02 Tamaños variantes y extras | D/P | D | D | Verificar vínculo entre extra e ingrediente |
| 03 Diseño y costeo del menú | NV | P/D | A | MarketMan, KitchenCUT, Apicbase |
| 04 Pronóstico de demanda | NV | I | NV | Tenzo; motor propio posteriormente |
| 05 Promociones y descuentos | D | D | D | Medir contribución incremental |
| 06 Órdenes mesas y canales | D/P | D | D | Conservar el frente de venta |
| 07 Comandas y cocina | D/P | D/A | D/A | No rehacer KDS en el MVP |
| 08 Pago propina devolución | D/P | D | D | Integrar conciliación y anomalías |
| 09 Caja y cierre de turno | D | D | D | Agregar trazabilidad del descuadre |
| 10 Documentos fiscales | D/P | P por país | D | Usar proveedor y versión del país |
| 11 Delivery y venta online | P | I | I | Integraciones actuales del POS |
| 12 Clientes fidelización | NV/P | D/A/I | D/P | Especialistas; no prioridad inicial |

Fuentes: oferta local SumUp [S10](https://www.sumup.com/es-cl/punto-de-venta/) [S11](https://www.sumup.com/es-cl/tipos-de-negocios/cafeterias/), módulos y catálogo Goodtill [S02](https://support.thegoodtill.com/modules) [S03](https://support.thegoodtill.com/ingredientsetup) [S12](https://support.thegoodtill.com/support/api) [S21](https://support.thegoodtill.com/back-end), productos e integraciones Toteat [S22](https://toteat.com/es-cl/productos/control-de-inventarios-y-stock) [S23](https://toteat.com/es-cl/productos/reportes-y-analisis-en-tiempo-real) [S24](https://toteat.com/es-cl/terminos-y-condiciones), previsión Tenzo [S09](https://www.gotenzo.com/integration/sumup/). D/P en pagos significa que el flujo básico está documentado pero los casos de reembolso, división y conciliación requieren prueba local.

### Recetas abastecimiento y almacenamiento

| Proceso | SumUp Chile | Goodtill | Toteat | Complemento o decisión |
|---|---|---|---|---|
| 13 Ingredientes y unidades | NV | D | A/D | Núcleo del nuevo SaaS |
| 14 Recetas y subrecetas | NV | D | A/D | Versiones y rendimiento medido |
| 15 Sustituciones de leche y extras | NV | D/P | P | Probar reemplazo versus adición |
| 16 Proveedores y formatos de compra | NV | D | A/D | Normalización por proveedor |
| 17 Comparación histórica de precios | NV | P | P | Alertas por unidad comparable |
| 18 Órdenes de compra y aprobación | NV | D/P | P | MarketMan, Apicbase o módulo propio |
| 19 Recepción parcial y discrepancias | NV | D/P | P | Separar recepción de factura |
| 20 Facturas de compra y captura | NV | P/I | A/D | OCR complementario; revisar API |
| 21 Stock por artículo terminado | D | D | D | No es una diferenciación suficiente |
| 22 Stock por ingrediente y bodega | NV | D/P | A/D | Exactitud y facilidad de conteo |
| 23 Traslados entre locales | NV | D | A/D | Inventario en tránsito y recepción |
| 24 Inventarios físicos y diferencias | P/NV | D | A/D | Conteos cíclicos móviles |
| 25 Lotes caducidad y FEFO | NV | NV | NV | Apicbase o solución especializada |
| 26 Reposición sugerida | NV | P/I | P | Combinar demanda y abastecimiento |

Fuentes: ingredientes y producción Goodtill [S03](https://support.thegoodtill.com/ingredientsetup) [S04](https://support.thegoodtill.com/support/production-events), compras y diferencias [S05](https://support.thegoodtill.com/advanced-stock-purchase-orders) [S25](https://support.thegoodtill.com/advanced-stock-faqs) [S26](https://support.thegoodtill.com/advanced-stock-reports), formación y producto Toteat [S01](https://learning.toteat.com/product/introduccion-a-inventarios-toteat) [S22](https://toteat.com/es-cl/productos/control-de-inventarios-y-stock), compras y transferencias vía API [S27](https://developers.toteat.com/paths/create_purchase_movements.yaml) [S28](https://developers.toteat.com/webhooks/transfer_webhooks.yaml), capacidades Apicbase y MarketMan [S29](https://get.apicbase.com/) [S30](https://www.marketman.com/). FEFO significa utilizar primero lo que vence antes. No se verificó su profundidad nativa en los dos POS.

### Producción personas y calidad

| Proceso | SumUp Chile | Goodtill | Toteat | Complemento o decisión |
|---|---|---|---|---|
| 27 Plan diario de preparación | NV | P | P | Forecast más recetas y vida útil |
| 28 Producción por lote y rendimiento | NV | D/P | A/D | Medir rendimiento real |
| 29 Mermas consumo interno cortesías | NV | D/P | P | Registro rápido y causa verificable |
| 30 Temperaturas limpieza inocuidad | NV | NV | NV | FoodDocs; no necesita ticket POS |
| 31 Alérgenos y fichas técnicas | NV | D/P | NV | Apicbase; verificación humana |
| 32 Apertura cierre y tareas | NV | NV | NV | Checklists simples propios o FoodDocs |
| 33 Turnos y asistencia laboral | NV/P | D/I | P | Planday o Rotaready según mercado |
| 34 Remuneraciones y obligaciones | NV | I/P | I/P | ERP o proveedor de nómina local |
| 35 Capacitación y SOP | NV | NV | NV | Biblioteca y evaluación; segunda fase |
| 36 Mantenimiento de equipos | NV | NV | NV | UpKeep o registro básico |
| 37 Seguridad incidentes accesos | P | P | P | Roles POS más sistema especializado |

Fuentes: producción y alérgenos Goodtill [S04](https://support.thegoodtill.com/support/production-events) [S21](https://support.thegoodtill.com/back-end); inventario Toteat [S01](https://learning.toteat.com/product/introduccion-a-inventarios-toteat); turnos y asistencia [S31](https://support.thegoodtill.com/support/planday) [S32](https://support.thegoodtill.com/rotaready); ERP [S33](https://toteat.com/productos/integraciones/integraciones-detalle/defontana) [S34](https://toteat.com/productos/integraciones/integraciones-detalle/softland-chile) [S35](https://toteat.com/productos/integraciones/integraciones-detalle/odoo); FoodDocs [S36](https://www.fooddocs.com/); mantenimiento [S37](https://upkeep.com/). Un permiso de cajero no equivale a gestión completa de personal; un registro de stock no equivale a control sanitario.

### Finanzas control de gestión y dirección

| Proceso | SumUp Chile | Goodtill | Toteat | Complemento o decisión |
|---|---|---|---|---|
| 38 Reportes de ventas y productos | D | D | D | Poco espacio para un clon genérico |
| 39 Margen teórico por preparación | NV | D/P | A/P | Costos históricos y cobertura visible |
| 40 Consumo real versus teórico | NV | D/P | P | Discrepancias explicadas y acciones |
| 41 Comparación multilocal | P/NV | D/I | D/P | Modelo homogéneo entre POS |
| 42 Conciliación ventas pagos abonos | P | P/I | P/I | Fuentes distintas y reglas auditables |
| 43 Cuentas por pagar y flujo de caja | P/NV | I | I | ERP; aprobar antes de pagar |
| 44 Contabilidad y resultado mensual | NV | I | I | Xero o ERP local |
| 45 Presupuesto y escenarios | NV | I/P | P/NV | Capa gerencial complementaria |
| 46 Rentabilidad por canal y promoción | P/NV | I/P | P | Incorporar comisiones y empaques |
| 47 Auditoría y anomalías | P | P | P | Evidencia y revisión; no acusaciones |
| 48 Gobierno datos permisos exportación | P | D/P | D/P | Núcleo transversal del SaaS |

Fuentes: reportes y términos Toteat [S23](https://toteat.com/es-cl/productos/reportes-y-analisis-en-tiempo-real) [S24](https://toteat.com/es-cl/terminos-y-condiciones), inventario Goodtill [S26](https://support.thegoodtill.com/advanced-stock-reports), Xero [S38](https://support.thegoodtill.com/support/xero-add-on), integraciones de gestión [S09](https://www.gotenzo.com/integration/sumup/) [S33](https://toteat.com/productos/integraciones/integraciones-detalle/defontana) [S34](https://toteat.com/productos/integraciones/integraciones-detalle/softland-chile) [S35](https://toteat.com/productos/integraciones/integraciones-detalle/odoo), APIs [S12](https://support.thegoodtill.com/support/api) [S15](https://developers.toteat.com/) [S16](https://developer.sumup.com/api/transactions) [S17](https://github.com/sumup/sumup-developer/blob/main/openapi.json) [S18](https://developer.sumup.com/tools/authorization/). P indica que la evidencia no permite afirmar un proceso completo de punta a punta.

**Lectura de la matriz:** las brechas más prometedoras son integración, adopción y profundidad de control. Los huecos de sanidad, nómina o mantenimiento tienen proveedores maduros, pero no necesariamente constituyen una buena puerta de entrada para este SaaS: exigen vender problemas y flujos distintos.

## 5 Qué complementos se pueden contratar

La distinción importante es entre un proveedor que resuelve el proceso, un conector publicado y una integración probada en la edición exacta del cliente. Este estudio confirmó documentación pública, no contrató ni probó estos servicios.

### Competidores y complementos centrales

| Proveedor | Procesos fuertes | Conexión observada | Madurez y límite |
|---|---|---|---|
| MarketMan | Inventario compras recetas costos y facturas | SumUp publicado; USA UK Australia; Toteat no verificado | Amplio y desarrollado; revisar familia POS y proveedores locales |
| Apicbase | Recetas producción compras inventario multilocal | Ficha Goodtill publicada; Toteat no verificado | Amplio para operaciones complejas; cotizar implantación |
| KitchenCUT | Gestión de cocina costos y stock | Goodtill documenta envío diario de ventas | Conector detallado; no es actualización instantánea |
| Tenzo | Reportes consolidados previsión y productividad | Goodtill con guía de campos y frecuencia | Analítica desarrollada; no sustituye los movimientos operativos |
| MarginEdge | Facturas costos recetas y resultado operativo | POS múltiples; estos dos conectores no verificados aquí | Competidor de referencia fuerte; alcance local por comprobar |
| Supy | Compras inventario y operación de cadenas | Conectores de esta pareja no verificados | Referencia para back office multilocal |
| Nory | Demanda personal y operación | Conectores de esta pareja no verificados | Competidor de la propuesta de gestión asistida por IA |
| Restaurant365 | Contabilidad inventario personal y gestión | Conectores de esta pareja no verificados | Suite amplia; referencia de expansión, no MVP a copiar |
| WISK | Inventario bebidas costos y control de consumo | Conectores de esta pareja no verificados | Especialista relevante para bares y mix de bebidas |

Fuentes: MarketMan [S06](https://www.marketman.com/partner/sumup) [S30](https://www.marketman.com/) [S39](https://www.marketman.com/pricing-for-restaurant-inventory-management-system); Apicbase [S08](https://partners.apicbase.com/integrations/goodtill) [S29](https://get.apicbase.com/); KitchenCUT [S07](https://support.thegoodtill.com/support/kitchencut); Tenzo [S09](https://www.gotenzo.com/integration/sumup/) [S40](https://support.gotenzo.com/integration-guides/sales/guide-goodtillsumup/); MarginEdge [S41](https://www.marginedge.com/pricing/); Supy [S42](https://supy.io/); Nory [S43](https://www.nory.ai/); Restaurant365 [S44](https://www.restaurant365.com/); WISK [S45](https://www.wisk.ai/). “Amplio” significa varios flujos detallados por el fabricante; no certifica satisfacción ni calidad comparativa.

**MarketMan es competencia directa, no una idea adyacente.** Su página específica de precios publica Starter US$249 mensuales, Growth US$299 y Enterprise desde US$449. Incluye costeo, comparación real versus teórico y captura de facturas según plan. Su portada todavía muestra importes inferiores; se toma el tarifario dedicado como referencia, se registra la discrepancia y se requiere cotización por local, moneda, impuestos e implementación. Las integraciones EDI de proveedores se limitan allí a Estados Unidos, Canadá y Reino Unido: esa red no se traslada automáticamente a Chile. [S39](https://www.marketman.com/pricing-for-restaurant-inventory-management-system) [S30](https://www.marketman.com/)

**KitchenCUT muestra qué significa un conector concreto.** Goodtill envía al final del día productos y opcionalmente modificadores; exige SKU numérico. El precio del modificador queda incluido en la línea principal y se envía en cero en su propio registro. Esto obliga a mapear correctamente consumo e ingresos para no duplicarlos. [S07](https://support.thegoodtill.com/support/kitchencut)

**Tenzo demuestra que reporting transversal ya es una categoría.** Su guía Goodtill admite local, producto, modificadores, descuentos y propinas; el polling predeterminado es horario y existe opción de tiempo real. No soporta en esa guía tiempos de delivery ni KDS. Estos límites son del conector descrito, no una prueba de que Goodtill carezca de esos datos. [S40](https://support.gotenzo.com/integration-guides/sales/guide-goodtillsumup/)

**MarginEdge publica US$350 por local al mes**, con procesamiento de facturas, recetas y control de costos. Sirve como referencia de valor y precio de una solución de back office, no como cotización disponible en Chile ni como integración confirmada con estos POS. [S41](https://www.marginedge.com/pricing/)

### Complementos por especialidad

| Necesidad | Servicio y compatibilidad | Qué verificar antes de contratar |
|---|---|---|
| Planificación de personal | Planday con Goodtill | Plan pagado con integraciones; ingreso neto enviado por hora [S31](https://support.thegoodtill.com/support/planday) |
| Turnos asistencia nómina | Rotaready con Goodtill | Usuario separado; alcance regional y costo del proveedor [S32](https://support.thegoodtill.com/rotaready) |
| Contabilidad UK | Xero con Goodtill | Cuentas impuestos y medios de pago correctamente mapeados [S38](https://support.thegoodtill.com/support/xero-add-on) |
| Contabilidad Chile | Defontana Softland Odoo publicados por Toteat | Alcance exacto, implementador y conciliación de errores [S33](https://toteat.com/productos/integraciones/integraciones-detalle/defontana) [S34](https://toteat.com/productos/integraciones/integraciones-detalle/softland-chile) [S35](https://toteat.com/productos/integraciones/integraciones-detalle/odoo) |
| Sanidad y registros | FoodDocs independiente | Localización, protocolos y sensores; conector POS no verificado [S36](https://www.fooddocs.com/) |
| Equipos y mantenimiento | UpKeep independiente | Costo por usuario, activos y procedimientos; conector POS no verificado [S37](https://upkeep.com/) |
| Unificación de APIs | Chift publica SumUp y Tiller | Familia POS, campos y continuidad; no elimina restricciones del origen [S46](https://www.chift.eu/integrations/sumup) [S47](https://www.chift.eu/tools/tiller) |

Contabilidad, nómina y sanidad no deben confundirse con módulos de stock. Para mantenimiento o limpieza se puede contratar una solución independiente sin necesitar una integración POS. Para costo teórico e inventario por receta, en cambio, la calidad del detalle de venta sí es decisiva.

### Qué stack puede resolver hoy el problema

En un comercio Goodtill compatible, se puede evaluar Goodtill con su propio stock avanzado, o un especialista de inventario; añadir Tenzo si se necesita analítica transversal, Planday/Rotaready para personal y Xero para contabilidad. No conviene pagar simultáneamente varios motores de stock sin definir uno como fuente autorizada.

Para Toteat Chile, la primera alternativa a contrastar es **usar correctamente Inventario Avanzado más una integración contable**, y medir qué sigue sin resolverse. El SaaS nuevo tiene que superar esa alternativa en tiempo de puesta en marcha, uso cotidiano, exactitud y decisiones; compararse solo con planillas sería un benchmark incompleto.

Para SumUp Chile, no quedó demostrado un stack de recetas y compras con conexión lista para contratar a partir de la documentación examinada. Hay proveedores potenciales, pero faltan confirmación de familia y acceso a órdenes. Esta es simultáneamente una posible brecha comercial y una barrera técnica.

## 6 Dónde está la oportunidad defendible

### Hipótesis priorizadas

| Hipótesis | Valor potencial | Dificultad principal | Prioridad |
|---|---|---|---|
| Puesta en marcha asistida desde facturas y menú | Evita semanas de carga manual | Normalizar unidades y validar recetas | Muy alta |
| Control de margen específico de cafetería | Hace visibles pérdidas pequeñas y frecuentes | Sustituciones tamaños mermas y empaques | Muy alta |
| Gestión de excepciones y acciones diarias | Convierte datos en decisiones verificables | Priorizar sin generar alertas inútiles | Muy alta |
| Consolidación multilocal y multi POS | Reduce conciliaciones y planillas | Datos heterogéneos y cierres distintos | Alta |
| Inventario móvil de baja fricción | Mejora calidad del dato de entrada | Adopción por personal de tienda | Alta |
| Dashboard genérico de ventas | Implementación relativamente simple | Ya incluido o cubierto por terceros | Baja como negocio aislado |
| Chat sobre el POS | Interfaz atractiva | Fácil de copiar y difícil de confiar | Complemento |
| ERP completo universal | Gran amplitud | Dispersión y costo de soporte | No iniciar allí |

Esta priorización es propia. Debe validarse contra clientes que utilicen activamente los módulos avanzados, no solo contra usuarios que desconocen su existencia.

### Qué significa ser la mejor opción para este segmento

La superioridad debe ser verificable: menos horas de implantación, menor tiempo semanal de administración, cifras conciliadas y mejoras operativas observables. “Más funciones” no es una métrica suficiente. Tampoco lo es colocar IA encima de reportes incompletos.

Un producto de cafeterías debería resolver bien situaciones que un inventario genérico trata con dificultad: cambio de leche como sustitución, shot adicional, bebidas de distintos tamaños, pérdida en vaporización, calibración de café, vasos para llevar, bollería recibida lista, producto vencido al cierre, promociones de último horario y producción de bases o jarabes.

El conocimiento de Brewit es un punto de partida para diseñar esas pruebas. No valida por sí solo el mercado. Hay que comprobar que el problema se repita en operadores con otra carta, equipo y disciplina administrativa.

La defensa competitiva probable combina un modelo de datos confiable, conectores mantenidos, flujos que el personal adopta, biblioteca de equivalencias y evidencia de resultados. No reside en un dashboard, en un modelo de IA disponible para todos ni en conservar cautivos los datos del cliente.

## 7 Viabilidad de integración y datos

### La base de datos interna no es necesaria

No se puede reconstruir responsablemente la base privada de estos proveedores desde sus páginas comerciales. Sí se puede estudiar el **contrato público de datos**: entidades, identificadores, relaciones, eventos, permisos y límites. Con eso se diseña un modelo propio estable y adaptadores por proveedor. No se necesita acceso directo a su base productiva ni ingeniería inversa de endpoints privados.

La arquitectura comercial debe distinguir cuatro niveles de conexión:

| Nivel | Datos disponibles | Qué puede ofrecer el SaaS |
|---|---|---|
| F0 Archivos | Exportaciones periódicas | Reporting diferido y validación inicial |
| F1 Pagos | Cobros devoluciones comisiones abonos | Conciliación financiera y tendencias de cobro |
| F2 Órdenes completas | Líneas extras cantidades descuentos canales | Recetas consumo teórico y margen por producto |
| F3 Operación ampliada | Compras stock personal y eventos | Control real versus teórico y automatización operativa |

Un cliente F1 no debe recibir una promesa F3. Si cobra un importe manual sin registrar productos, la IA no puede saber qué ingredientes se consumieron. Se necesita capturar el ticket en otra fuente, introducir datos o reducir el alcance del producto.

### Toteat tiene un contrato público útil

La documentación enlaza `toteatApi_v2.yaml`, con OpenAPI 3.0.1 e información de versión 1.0. El nombre del archivo no debe interpretarse como versión efectiva del servicio. La introducción recomienda las bases `https://api.toteat.com/mw/or/1.0/` y `https://apidev.toteat.com/mw/or/1.0/`. El bloque `servers` conserva una URL anterior de desarrollo, por lo que un generador automático de clientes debe revisar esa discrepancia antes de usarse. [S15](https://developers.toteat.com/)

| Interfaz documentada | Uso para el SaaS | Condición relevante |
|---|---|---|
| GET /products | Catálogo extras y categorías | Activos por defecto; cargar también inactivos históricos |
| GET /sales | Ventas y pagos de órdenes cerradas | Ventana máxima 15 días; 3 solicitudes por minuto |
| GET /collection | Cuadre por cajas y métodos | Un día por llamada; 3 solicitudes por minuto |
| GET /inventorystate | Saldos y movimientos por bodega | Máximo 15 días; costo descrito como estándar |
| GET /accountingmovements | Cruce con registros contables | Validar cobertura y semántica por ambiente |
| GET /orders/cancellation-report | Cancelaciones | Complementar ventas para evitar omisiones |
| GET /fiscaldocuments | Documentos fiscales | Relacionar documentos y pagos |
| GET /orderstatus y /shiftstatus | Estado de órdenes y turnos | Complemento de sincronización |
| POST /purchasemovements | Facturas de ingredientes | Modifica inventario inmediatamente; no usar en primera fase |
| Webhooks de orden menú turno traslado | Actualización por eventos | Alcance y configuración diferentes |

Fuentes: rutas públicas [S15](https://developers.toteat.com/) [S27](https://developers.toteat.com/paths/create_purchase_movements.yaml) [S48](https://developers.toteat.com/paths/sales.yaml) [S49](https://developers.toteat.com/paths/inventorystate.yaml) [S50](https://developers.toteat.com/paths/products.yaml) [S51](https://developers.toteat.com/paths/collection.yaml) [S52](https://developers.toteat.com/paths/orders_cancellation_report.yaml) [S53](https://developers.toteat.com/paths/fiscaldocuments.yaml). Los límites citados son los publicados en las rutas; su unidad de aplicación contractual y posibles ampliaciones deben confirmarse. No se presupone que puedan multiplicarse libremente por token.

El acceso usa `xir`, `xil`, `xiu` y `xapitoken`: restaurante, local, usuario y token. La configuración la autoriza el dueño y permite habilitar rutas. Como el token viaja en parámetros de consulta, el conector debe eliminarlo de logs, trazas, errores y herramientas analíticas. No se pedirá la contraseña personal del dueño. [S54](https://developers.toteat.com/tags/config_tag.yaml)

### Cinco trampas concretas de Toteat

**1 Ventas por turno versus fecha de calendario.** `/sales` busca por fecha del turno. Un turno abierto varios días puede dejar ventas fuera de una consulta por día civil. Guardar apertura/cierre y fecha comercial; mantener una lista de turnos abiertos para volver a consultar incluso si son antiguos. [S48](https://developers.toteat.com/paths/sales.yaml)

**2 Granularidad por pago.** El resultado contiene pagos de órdenes cerradas. Una orden puede tener varios pagos. Construir órdenes, líneas y pagos por separado; no sumar repetidamente las mismas líneas al procesar pagos o documentos rectificatorios. [S48](https://developers.toteat.com/paths/sales.yaml) [S55](https://developers.toteat.com/components/schemas.yaml)

**3 Un campo engañoso.** El esquema de producto define `netPrice` como precio bruto pese a su nombre. En ambientes migrados aparecen campos como `unitPriceBeforeTaxes`, `lineId` y `lineReference`; no asumir su disponibilidad en legacy. Una interpretación equivocada puede inflar o reducir artificialmente el margen. [S55](https://developers.toteat.com/components/schemas.yaml)

**4 Webhook global restringido.** El webhook normal de órdenes se limita a las creadas por esa API. Para recibir todas las órdenes del local se requiere habilitación de soporte, y solo una API estándar por local puede tener esa opción. Esto puede interferir con otra integración existente; resolver coexistencia antes de vender tiempo real. [S56](https://developers.toteat.com/webhooks/order_webhooks.yaml)

**5 Datos y ejemplos no totalmente uniformes.** Hay IDs y fechas representados con tipos diferentes y ejemplos con formatos heterogéneos. En inventario, el signo del campo de uso requiere confirmación con casos reales. Tratar los IDs externos como cadenas opacas, utilizar tipos decimales y validar cada payload, sin “corregir” silenciosamente valores dudosos. [S49](https://developers.toteat.com/paths/inventorystate.yaml) [S55](https://developers.toteat.com/components/schemas.yaml)

Los webhooks documentan HTTPS, respuesta rápida y reintentos limitados. La solución debe confirmar recepción después de persistir el evento, procesarlo fuera de la petición y ejecutar conciliación periódica; los webhooks por sí solos no garantizan historial completo. [S57](https://developers.toteat.com/tags/webhooks_tag.yaml)

### SumUp requiere al menos dos conectores conceptuales

**Pagos:** el OpenAPI revisado cubre checkouts, transacciones, abonos, recibos, lectores y entidades de comercio. No se encontraron allí recursos generales de órdenes, recetas o bodegas. La transacción puede incluir `products`, pero ese campo no prueba cobertura universal de tickets, modificadores ni ventas en efectivo. Para SaaS multicomercio SumUp recomienda OAuth 2.0. [S16](https://developer.sumup.com/api/transactions) [S17](https://github.com/sumup/sumup-developer/blob/main/openapi.json) [S18](https://developer.sumup.com/tools/authorization/)

**Goodtill:** tiene API propia de tienda y autenticación JWT tras login. La documentación permite datos comerciales y reportes; sus webhooks notifican ventas completadas o anuladas y cambios de stock, entre otros eventos. No son las mismas credenciales ni el mismo contrato de la API de pagos. [S12](https://support.thegoodtill.com/support/api) [S58](https://support.thegoodtill.com/support/webhook)

**POS actual Chile y Register:** la existencia de un producto y de SDKs de cobro no confirma que terceros puedan leer todas sus órdenes. La página chilena de integraciones se concentra en aceptar pagos. Antes de desarrollar, exigir documentación y una muestra autorizada de ventas con efectivo, extras, anulaciones, pagos divididos y sucursales. [S10](https://www.sumup.com/es-cl/punto-de-venta/) [S19](https://www.sumup.com/en-gb/pos-register/) [S59](https://www.sumup.com/es-cl/integraciones/)

### Resultado técnico por plataforma

| Plataforma | Confianza documental | Decisión |
|---|---|---|
| Toteat | Alta para existencia de interfaces; ejecución no probada | Primera integración de negocio |
| SumUp pagos | Alta para pagos; insuficiente para recetas | Conector financiero separado |
| Goodtill | Alta para API y stock documentados | Piloto condicionado a continuidad y acceso comercial |
| SumUp POS actual Chile | Media funcional; acceso al ticket no confirmado | Investigación comercial técnica antes de construir |
| Tiller POS Pro | Riesgo alto por aviso explícito | No iniciar un conector nuevo |

## 8 Modelo de datos recomendado

El siguiente esquema es una **propuesta propia**, no la base interna de SumUp o Toteat. Permite cambiar de POS sin rehacer recetas, inventario, costos o reportes.

| Dominio | Entidades principales | Regla de diseño |
|---|---|---|
| Organización | Tenant, LegalEntity, Brand, Location, Warehouse | Aislamiento por cliente y permisos por local |
| Integración | Connection, ExternalIdentifier, RawEvent, SyncCursor | Proveedor y familia explícitos; conservar procedencia |
| Venta | Order, OrderLine, ModifierSelection, DiscountAllocation | Líneas independientes de los cobros |
| Recaudación | Payment, PaymentAllocation, Refund, Settlement, Fee | Relaciones muchos a muchos donde corresponda |
| Catálogo | MenuItem, Variant, ModifierGroup, PriceVersion | No usar el nombre como identificador |
| Recetas | Recipe, RecipeVersion, RecipeComponent, YieldRule | Versiones vigentes por local y fecha |
| Insumos | Ingredient, UnitOfMeasure, Conversion, SupplierItem | Separar unidad base y formato comprado |
| Abastecimiento | Supplier, PurchaseOrder, Receipt, SupplierInvoice | Pedido recepción y factura son hechos distintos |
| Existencias | InventoryMovement, StockCount, Lot, Transfer | Libro de movimientos auditable |
| Producción | ProductionBatch, BatchInput, BatchOutput, WasteEvent | Consumo y rendimiento por lote |
| Gestión | CostSnapshot, MetricDefinition, Forecast, Action | Toda cifra tiene definición y fuente |
| Personas y operación | LaborShift, LaborCost, Checklist, Incident | Incorporar por integración o captura acotada |

### Relaciones que no se deben simplificar

Una orden tiene muchas líneas y puede tener varios pagos; un pago puede cubrir solo una parte de la orden. Una devolución afecta dinero, pero no necesariamente devuelve leche, café o bollería al stock. Una receta puede contener subrecetas; una producción consume insumos y genera un semielaborado. Una venta de ese semielaborado no debe descontar otra vez las materias primas consumidas durante la producción.

Un ingrediente puede comprarse en caja, bolsa o botella y consumirse en gramos, mililitros o unidades. Convertir masa a volumen requiere una equivalencia específica; no asumir que un mililitro equivale a un gramo. Un producto de venta puede compartir nombre entre locales y tener distintas recetas o precios.

### Correspondencias verificables con Toteat

| Dato Toteat | Destino propuesto | Observación |
|---|---|---|
| xir y xil | ExternalIdentifier de empresa y local | No confundir cuenta con local |
| orderId | Order.external_id | Guardar como cadena |
| paymentId | Payment.external_id | No usar como ID de orden |
| products.id | MenuItem.external_id | Código comercial; distinguir ID interno cuando exista |
| lineId y lineReference | OrderLine y línea padre | Campos condicionales de ambiente migrado |
| isExtra y referenceLine | ModifierSelection | Disponibles en estructura expandida de orden |
| subtotal taxes gratuity | Venta neta impuestos propina | Validar conciliación por tipo documental |
| product_id y warehouse_id | Ingredient y Warehouse | Espacio de IDs distinto del menú de venta |
| initial_inventory final_inventory | Snapshot o saldo de control | No tratarlos automáticamente como movimiento |
| purchase use transformed | Movimientos o agregados de control | Verificar signo y evitar doble contabilización |
| requisition_id | Transfer.external_id | Eventos multilocal sujetos a requisitos |

Fuentes: esquemas [S55](https://developers.toteat.com/components/schemas.yaml), rutas de inventario [S49](https://developers.toteat.com/paths/inventorystate.yaml) y transferencias [S28](https://developers.toteat.com/webhooks/transfer_webhooks.yaml). La API examinada no demostró un CRUD completo de recetas; planificar importación autorizada o configuración en el SaaS, y preguntar por interfaces adicionales.

### Campos mínimos para cualquier adaptador

Cada registro canónico debe incluir tenant, conexión, proveedor, familia de producto, local, ID externo, fecha del evento, fecha comercial, fecha de recepción, moneda, estado, versión y referencia al payload original. Añadir indicadores de completitud: línea identificada, modificador vinculado, costo disponible, canal conocido y conciliación superada.

El cliente debe poder distinguir **costo confirmado**, **costo estimado** y **costo desconocido**. Un valor desconocido no se convierte en cero. Lo mismo aplica a locales sin sincronización y a ventas cuyo canal no esté registrado.

## 9 Producto propuesto y experiencia cotidiana

### Primer producto vendible

El alcance inicial reúne cuatro capacidades que se refuerzan entre sí: datos de venta conciliados, recetas y costos, compras/recepciones, y conteos/mermas. El dashboard es la salida visible de ese sistema; por sí solo no produce control operativo.

| Persona | Trabajo que debe poder terminar | Resultado verificable |
|---|---|---|
| Dueño | Revisar locales y excepciones en pocos minutos | Identifica qué requiere intervención |
| Encargado | Recibir mercadería y registrar discrepancias | Stock y factura no se confunden |
| Barista | Registrar merma o repetir bebida | Pérdida queda cuantificada sin fricción |
| Encargado de inventario | Contar insumos prioritarios | Diferencias trazables y revisables |
| Administración | Validar factura y cambios de costo | Costo vigente con respaldo |

### Un ejemplo específico de cafetería

Una venta de latte de 16 oz con leche de avena y shot extra debe resolver primero la receta vigente del tamaño; después sustituir la leche, agregar el café adicional y sumar vaso/tapa solo si es para llevar. Un precio de extra igual a cero no implica consumo cero. Si se repite la bebida por un error, registrar su consumo aunque no exista una segunda venta.

Las cantidades se parametrizan y se validan con el operador. No inferir una receta desde el tamaño nominal del vaso ni asumir que bebidas calientes y frías usan las mismas proporciones. Los ejemplos de Brewit sirven para probar el motor, no para imponer recetas universales.

### Onboarding como parte central del producto

1. Conectar el POS y mostrar un diagnóstico del acceso: solo pagos, ticket completo o datos operativos.
2. Importar catálogo e histórico suficiente; reconciliar ventas antes de mostrar márgenes.
3. Capturar facturas y reconocer proveedores, formatos y precios, siempre con revisión de equivalencias.
4. Cargar o proponer recetas de los productos que concentran la mayor venta. Toda propuesta de IA queda pendiente de aprobación.
5. Realizar un inventario inicial acotado de insumos relevantes.
6. Activar conteos cíclicos, recepción y merma; completar progresivamente el resto del catálogo.
7. Emitir el primer diagnóstico con cobertura explícita y una acción concreta.

Objetivos a validar: primera lectura útil en un día y primera semana operativa sin planillas paralelas para el alcance piloto. No son promesas comerciales hasta medirlos. Si cada nuevo cliente exige consultoría extensa, el costo de implementación debe cobrarse o el diseño debe simplificarse.

### IA con responsabilidad delimitada

Usar IA para interpretar facturas, sugerir equivalencias, asistir con recetas, explicar métricas y ordenar alertas. Mantener cálculos, impuestos, conversiones, movimientos y reglas de autorización en código determinista. Toda respuesta sobre rentabilidad debe indicar período, local, cobertura de costos y registros de respaldo.

No autorizar a la IA a emitir compras, cambiar recetas vigentes, alterar precios o imputar pérdida a una persona sin revisión. El valor buscado es reducir trabajo y mejorar decisiones, no generar una narrativa convincente sobre datos deficientes.

## 10 Reporting que sí puede diferenciarse

### Definiciones financieras propuestas

| Indicador | Definición de gestión | Precaución |
|---|---|---|
| Venta neta | Venta reconocida menos impuestos indirectos y descuentos pertinentes | Excluir propinas; separar cobro de venta |
| Costo teórico vendido | Cantidad vendida por receta vigente y costo histórico | Mostrar cobertura de recetas y precios |
| Consumo físico | Inicial más entradas menos salidas no consumptivas menos final | Ajustar traslados y producción sin duplicar |
| Variación no explicada | Consumo físico menos consumo esperado y salidas identificadas | No equivale automáticamente a robo |
| Margen de contribución | Venta neta menos insumos empaques y costos variables definidos | Enumerar costos incluidos |
| Prime cost | Costo operativo de alimentos y bebidas más costo laboral definido | Evitar sumar merma dos veces |
| Resultado operativo | Contribución menos personal y gastos operativos pertinentes | No llamarlo EBITDA sin definición contable |

Para reportes provisionales, puede estimarse un costo diario a partir de recetas. Para costo realizado se necesitan conteos y movimientos; no presentar ambos como equivalentes. El costo de compra más reciente tampoco es necesariamente el costo histórico de lo vendido. Elegir y documentar la política de valoración con el área contable.

### Pantalla de dirección multilocal

Una fila por local y una fila total. Para mes anterior, mes actual, semana anterior, semana actual, ayer y hoy, mostrar ventas y margen definido. Mantener visibles encabezados y nombre del local durante el desplazamiento horizontal y vertical. El total del porcentaje de margen es la suma de márgenes monetarios dividida por la suma de ventas, nunca el promedio simple de porcentajes.

Comparaciones sugeridas: semana anterior frente al promedio de las ocho semanas completas previas; ayer frente a los ocho días equivalentes anteriores; y ayer frente al promedio de días abiertos de las cuatro semanas previas. Excluir el período comparado del promedio, mostrar el número de observaciones e identificar feriados, cierres y datos faltantes. Una sucursal sin conexión se muestra como pendiente, no como venta cero.

No comparar hoy a mediodía con todo el día anterior sin advertirlo. Presentar a la misma hora o como períodos completos separados. Mantener calendario de apertura por local, fecha comercial del POS y zona horaria `America/Santiago` cuando corresponda. “Tiempo real” debe incluir la última sincronización y no prometerse si el origen solo actualiza por cierre.

### Acciones gerenciales de alto valor

| Señal | Explicación que debe buscar | Acción sugerida |
|---|---|---|
| Venta sube margen baja | Mix descuentos leche premium o costo de compra | Revisar productos y reglas de precio |
| Leche real excede teórica | Receta conteo vaporización o desperdicio | Medición breve y ajuste validado |
| Bollería merma al cierre | Pronóstico compra o promoción mal calibrada | Cambiar pedido y medir venta perdida |
| Diferencias repetidas en recepción | Formato de proveedor faltantes o errores | Reclamo respaldado y revisión de equivalencias |
| Abono menor que cobros | Comisiones devoluciones desfase o retención | Conciliar antes de alertar pérdida |
| Local con margen muy distinto | Precios recetas costos o calidad del dato | Comparar mismas definiciones |

La aplicación debe cerrar el ciclo: alerta, responsable, acción, fecha y resultado. Para demostrar ahorro, medir antes y después con controles de estacionalidad y volumen; no adjudicar al software toda mejora de ventas o margen.

## 11 Arquitectura técnica del SaaS

### Estructura recomendada

Comenzar con un backend modular, base relacional y procesos de sincronización separados. No hace falta comenzar con microservicios. La aplicación actual de Brewit se debe auditar antes de elegir qué reutilizar; este informe no supone haber revisado su implementación.

| Capa | Responsabilidad |
|---|---|
| Adaptadores | Autenticación extracción límites eventos y capacidades por proveedor |
| Recepción de datos | Persistencia del original deduplicación cola y reintentos |
| Modelo canónico | Unificar órdenes pagos artículos movimientos y costos |
| Motores de negocio | Recetas unidades inventario valoración conciliación |
| Métricas | Definiciones versionadas agregaciones y trazabilidad |
| Aplicación | Flujos móviles panel de dueño acciones y configuración |
| Operación SaaS | Facturación permisos soporte observabilidad y exportación |

### Principios que evitan errores caros

- **Una fuente autorizada por dominio.** Si el SaaS lleva el inventario, no importar otra vez la deducción de stock del POS como una nueva deducción. Si Toteat es el maestro, comenzar en modo analítico y registrar allí los hechos autorizados.
- **Originales y revisiones.** Conservar payload y hash para poder reproducir una cifra, con retención y acceso definidos. Una corrección de venta genera una revisión o reversión, no un borrado invisible.
- **Sincronización idempotente.** Reprocesar un evento o una ventana histórica no debe duplicar ventas, costos ni movimientos.
- **Confiar poco en la puntualidad.** Eventos fuera de orden, reintentos y períodos offline son casos normales. Combinar eventos con reconciliación y backfill.
- **Límites por conector.** Cola y presupuesto de peticiones, backoff y tratamiento de 429. No escalar consultando cada local cada segundo.
- **Escrituras separadas.** Lectura primero. Para compras o cambios posteriores, usar outbox, control de duplicidad, permisos y confirmación de resultado.
- **Dinero y cantidades exactos.** Decimal para cantidades/costos; unidades menores o decimal para dinero. Respetar moneda y redondeo, sin asumir dos decimales para todas.
- **Privacidad por diseño.** Aislamiento por tenant, cifrado de secretos, mínimo privilegio y auditoría. No ingerir datos personales de clientes si la función solo requiere ventas agregadas.

### Contrato del adaptador

El contrato interno debe exponer capacidades como `supports_order_lines`, `supports_modifiers`, `supports_cash_sales`, `supports_global_webhooks`, `supports_inventory_read` y `supports_purchase_write`. Estos nombres son propuestos para la aplicación, no campos existentes de los proveedores.

Operaciones internas sugeridas: descubrir locales, sincronizar catálogo, recuperar órdenes por ventana, recuperar pagos y devoluciones, consultar movimientos y procesar eventos. Una capacidad ausente queda explícita; no se rellena con valores inventados ni mediante scraping silencioso.

Cada integración debe tener pruebas con payloads autorizados anonimizados y contratos versionados. Monitorear retraso de ingesta, duplicados, errores de esquema, órdenes sin detalle, ventas sin receta y diferencias contra el cierre del POS. El panel de soporte debe mostrar el problema sin exponer tokens.

### Historial y vigencias

Guardar versiones de receta y costo con inicio de vigencia. Si cambia el precio del café hoy, no recalcular silenciosamente el margen de hace tres meses con el precio nuevo. Permitir un modo separado de simulación que sí aplique costos actuales a ventas pasadas, y etiquetarlo como escenario.

Para transferencias, descontar del origen al despachar y reconocer inventario en tránsito; incrementar destino al recibir. Para devoluciones, decidir separadamente reversión monetaria y reintegro físico. Para conteos durante la venta, guardar hora de corte y movimientos intermedios.

## 12 Estrategia comercial y tamaño de oportunidad

### Selección inicial de mercado

**Primera ruta:** Chile con Toteat, porque el usuario ya tiene experiencia e integración propia. El primer objetivo es comprobar que el producto mejora el trabajo de operadores externos a Brewit.

**Segunda ruta:** un país y una familia SumUp con acceso confirmado a órdenes. Goodtill puede facilitar la prueba técnica, pero su ecosistema ya tiene competidores. SumUp Chile podría mostrar una brecha mayor, aunque el acceso a datos está menos claro. Son perfiles de riesgo diferentes, no una recomendación incondicional de país.

**Tercera ruta:** más POS y mercados una vez que el modelo funcione. La promesa multi POS se construye mediante adaptadores reales; no se obtiene conectando una API de pagos genérica.

### Dimensionamiento sin inventar el mercado

| Variable | Cómo obtenerla | Estado actual |
|---|---|---|
| Comercios F&B activos por país | Datos del proveedor o investigación sectorial validada | No disponible en este estudio |
| Comercios por familia POS | Partnership y muestras de onboarding | No disponible |
| Porcentaje con tickets utilizables | Prueba de datos estratificada | Por medir |
| Porcentaje con necesidad y presupuesto | Entrevistas más pilotos pagados | Por medir |
| Costo de adquisición y conversión | Campañas o canal de socios medidos | Por medir |
| Retención por segmento | Cohortes reales durante varios meses | Por medir |

Fórmula de mercado atendible: locales compatibles con datos suficientes multiplicados por proporción con necesidad y capacidad de pago, y por ingreso anual por local. Si las empresas compran varios locales, mantener separados clientes, locales y conexiones.

Como ejercicio de sensibilidad, no estimación de mercado: 1.000 locales a US$99 al mes generan US$1,188 millones de ingreso recurrente anual; 3.000 generan US$3,564 millones; 10.000 generan US$11,88 millones. La dificultad comercial es conseguir y retener esos locales con margen suficiente, no realizar la multiplicación.

### Precio a experimentar

| Paquete propuesto | Hipótesis mensual por local | Alcance inicial |
|---|---|---|
| Visibilidad | US$39 a US$59 | Ventas conciliadas reporting y alertas de datos |
| Control | US$89 a US$129 | Recetas compras conteos mermas y contribución |
| Cadena | US$149 a US$199 | Multilocal aprobaciones transferencias y gestión |

Son precios propuestos para experimentar, no precios de mercado validados. Cotizar en moneda local donde corresponda; definir límites de facturas, asistencia e integraciones. No vender un plan barato que requiera más soporte del que puede financiar. La implantación asistida puede tener un cobro separado y explícito.

El comparativo debe incluir el costo total del POS más sus módulos, no solo el precio del nuevo SaaS. Los importes públicos de MarketMan y MarginEdge muestran que existe oferta de mayor precio, pero no prueban cuánto pagaría una cafetería chilena. [S39](https://www.marketman.com/pricing-for-restaurant-inventory-management-system) [S41](https://www.marginedge.com/pricing/)

### Canales de adquisición

Priorizar venta directa a un segmento estrecho, referidos de operadores, asesores gastronómicos, contadores y distribuidores de café/equipos. Medir cada canal separadamente. Un acuerdo con SumUp o Toteat sería valioso, pero el plan base no debe depender de que ellos distribuyan la aplicación.

Para interesar al POS, demostrar menos abandono de sus clientes, mejor operación y más valor de su ecosistema sin interferir con el cobro. Solicitar condiciones de integración y marketplace, uso de marca, soporte, costos y reglas de revocación. No presentar una conexión técnica como una certificación o recomendación comercial del proveedor.

## 13 Economía y retorno a validar

Los siguientes cálculos son **escenarios propios**, no pronósticos ni recomendaciones de inversión financiera.

### Ejemplo de valor para una cafetería

Supongamos ventas netas mensuales de CLP 20 millones. Reducir un punto porcentual de costo evitable sobre ventas equivale a CLP 200.000 al mes. Si además se ahorran ocho horas administrativas valoradas por el cliente en CLP 10.000 cada una, el beneficio económico total sería CLP 280.000. Con una suscripción de CLP 90.000, quedarían CLP 190.000 antes de implementación y otros costos.

El ahorro de tiempo solo es flujo de caja si reduce horas pagadas o libera capacidad con valor real; no siempre es un ahorro monetario. No sumar una reducción de merma y una mejora de food cost cuando son el mismo efecto. Medir también quiebres de stock: bajar desperdicio dejando de vender no es necesariamente una mejora.

### Ejemplo de economía del SaaS

| Variable ilustrativa | Supuesto |
|---|---|
| Ingreso por local mensual | US$99 |
| Servicio variable por local | US$20 incluyendo infraestructura OCR y soporte variable |
| Contribución mensual | US$79 o 79,8% |
| Adquisición por local | US$400 |
| Recuperación de adquisición | 5,1 meses antes de implantación no cobrada |
| Si onboarding consume otros US$240 | Recuperación de 8,1 meses |

Con 500 locales, ese escenario produce US$49.500 de ingreso mensual y US$39.500 de contribución antes de equipo central, ventas, administración y otros gastos fijos. Una estructura fija de US$40.000 mensuales requeriría aproximadamente 507 locales para cubrirla con US$79 por local. No incluye expansión de costos por escala ni pérdidas iniciales.

La amenaza económica principal puede ser el soporte: múltiples POS, recetas mal cargadas y proveedores distintos generan trabajo humano. Medir horas de implantación, tickets por local, costo de OCR, tiempo de mantenimiento por conector y abandono. No estimar un LTV elevado antes de contar con retención observada.

## 14 Playbook de ejecución

### Etapa uno de días 1 a 30

Auditar la aplicación existente de Brewit: funciones reutilizables, dependencias de Toteat, modelo de datos, seguridad, pruebas, sincronización, costos y separación entre clientes. Documentar qué está probado con datos reales y qué es específico de un solo local.

Conseguir una muestra autorizada de Toteat de 30 a 90 días con catálogo, ventas, anulaciones y cierres. Ejecutar pruebas de granularidad y conciliación. En paralelo, solicitar a SumUp la familia exacta y acceso a ventas detalladas; no comenzar aún a programar un conector Tiller.

Entrevistar entre 15 y 20 operadores: incluir quienes usan módulos avanzados y quienes los abandonaron. Observar un conteo, una recepción y un cierre reales. Registrar tiempo, errores, frecuencia y costo del problema. Reclutar al menos cinco negocios externos dispuestos a probar, buscando compromiso de pago.

### Etapa dos de días 31 a 60

Implementar el modelo canónico de ventas y pagos, diagnóstico de datos, tablero multilocal y costeo histórico. Agregar recetas con sustituciones, unidades y subrecetas; importar compras con revisión humana. Probar primero las preparaciones y los insumos más relevantes.

Mantener modo lectura respecto del POS. El inventario del piloto puede operar en un libro propio, con conciliación y una autoridad definida. No activar escrituras de compra hasta demostrar que no generan entradas duplicadas.

### Etapa tres de días 61 a 90

Incorporar recepción, conteos, merma, diferencias y acciones. Ejecutar pilotos pagados durante varias semanas con operadores externos. Evaluar el segundo adaptador solo si hay un contrato de datos suficiente y comercialmente viable.

El objetivo a los 90 días es decidir con evidencia qué segmento compraría y retendría el producto. No es declarar terminada la mejor aplicación del mercado.

### Expansión posterior

De 3 a 6 meses, fortalecer compras, roles, transferencias, captura documental y segundo POS. De 6 a 12 meses, ampliar forecast, producción, contabilidad y personal según uso observado. Sanidad, mantenimiento y formación pueden integrarse o implementarse de forma ligera; no deben retrasar el control de margen.

Equipo orientativo: responsable de producto con experiencia operativa, dos desarrolladores con capacidad de backend/integraciones y frontend, y apoyo parcial de diseño, QA y onboarding. Es una propuesta de capacidad, no una estimación auditada del esfuerzo del código existente. Si solo trabaja una persona, reducir alcance y conectores.

## 15 Pruebas y criterios de avance

### Pruebas obligatorias de integración

| Caso | Resultado esperado |
|---|---|
| Pago mixto efectivo y tarjeta | Una venta; dos medios; sin duplicar líneas |
| Dos pagos para una orden | Ingresos y costos se reconocen una sola vez |
| Reembolso parcial posterior | Ajuste monetario correcto; stock depende del hecho físico |
| Anulación antes y después de preparar | Diferenciar venta cancelada de consumo o merma |
| Leche vegetal con precio cero | Sustituye insumo y cambia costo aunque no cambie precio |
| Turno abierto durante varios días | No desaparecen ventas al consultar por fecha civil |
| Corte de internet y eventos repetidos | Recuperación sin pérdida ni doble contabilización |
| Cambio retroactivo en POS | Revisión trazable y conciliación posterior |
| Factura y recepción del mismo ingreso | Una entrada física; un documento financiero |
| Transferencia incompleta | Diferencia visible entre enviado y recibido |
| Receta nueva a mitad del mes | Histórico conserva receta anterior |
| Producto sin receta o costo | Margen parcial etiquetado; no costo cero |
| Proveedor cambia de caja de 12 a 10 | Precio unitario y cantidad base se recalculan correctamente |
| Conteo con ventas en curso | Hora de corte y consumo intermedio preservados |
| Revocación del token | Cese de acceso y advertencia de datos desactualizados |

### Comparativa operativa con soluciones existentes

Usar la misma carta y el mismo conjunto de facturas en Toteat Avanzado, Goodtill si corresponde y al menos un especialista. Medir minutos para cargar 20 recetas, cambiar un formato de proveedor, recibir parcialmente una compra, contar diez insumos, explicar una diferencia y cerrar una semana. El test debe incluir el acompañamiento y costo total de implementación.

La evaluación debe ponderar adopción y confiabilidad: exactitud de cifras 30%, esfuerzo diario 25%, implantación 20%, control de excepciones 15% y costo total 10%. Estos pesos son propuestos y pueden ajustarse con entrevistas. No publicar una clasificación de “mejor” sin realizar la prueba.

### Umbrales de decisión sugeridos

| Dimensión | Señal para continuar | Señal para detener o cambiar |
|---|---|---|
| Datos | Conciliación completa; discrepancias explicadas | Faltan órdenes o líneas sin ruta de solución |
| Preparaciones | Al menos 95% de venta cubierta por recetas validadas en piloto | Costos mayormente estimados o desconocidos |
| Adopción | Encargados completan al menos 80% de rutinas acordadas | Dependencia continua del fundador para operar |
| Demanda | Al menos 5 pilotos pagados externos a Brewit | Interés verbal sin disposición a pagar |
| Valor | Beneficio verificable superior al precio y esfuerzo | Dashboard consultado sin cambios operativos |
| Servicio | Implantación y soporte compatibles con el precio | Consultoría permanente por cada cliente |
| SumUp | Ticket completo y continuidad de API confirmados | Solo pagos o plataforma sin futuro definido |

Los porcentajes y cantidades son metas de validación propuestas, no estándares sectoriales. Un piloto de 90 días no prueba la retención anual; antes de escalar adquisición se necesitan cohortes adicionales.

## 16 Preguntas exactas para cerrar los vacíos

### Para SumUp

1. ¿Cuál es la familia técnica del POS de cada país objetivo y qué continuidad tendrá durante los próximos 24 meses?
2. ¿Existe API comercial autorizada de catálogo, órdenes, líneas, modificadores, anulaciones y ventas en efectivo para la oferta actual en Chile y Register?
3. ¿Cuál es la relación entre cuenta de comercio, local, caja y dispositivo, y cómo se mapean sus IDs?
4. ¿Qué permisos OAuth, proceso de revisión, sandbox y condiciones de partnership requiere un SaaS de terceros?
5. ¿Qué límites, retención histórica, eventos, garantías de entrega y mecanismos de backfill existen?
6. ¿Qué parte del aviso Tiller/POS Pro afecta a cada país y cuál es el producto de reemplazo?
7. ¿Las integraciones MarketMan, Tenzo o Apicbase aplican a esa edición exacta? ¿En qué países y con qué frecuencia de actualización?
8. ¿Hay cargos, restricciones de almacenamiento, exportación, uso de marca o condiciones de distribución para esta aplicación?

### Para Toteat

1. ¿La cuenta y los locales están en legacy o migrados, y cuáles campos están disponibles efectivamente?
2. ¿Puede activarse el webhook global y ya lo ocupa otra integración? ¿Qué alternativa autorizada existe para coexistir?
3. ¿Los límites se aplican por ruta, token, local o restaurante? ¿Se pueden ampliar por contrato?
4. ¿Existe interfaz documentada para leer y mantener recetas, proveedores, unidades y costos históricos?
5. ¿Cómo se representan extras, pagos divididos, anulaciones y notas de crédito en cada ambiente?
6. ¿Qué garantías de idempotencia tiene la escritura de compras? ¿Cómo consultar si un envío ambiguo ya fue aplicado?
7. ¿Cómo se exponen compras, transferencias, producción y ajustes con IDs de movimiento y signos consistentes?
8. ¿Qué condiciones comerciales permiten distribuir y dar soporte a una integración SaaS multicliente?

### Contradicciones pendientes registradas

La página comercial de reportes de Toteat promete información en tiempo real, mientras sus condiciones describen Analytics actualizado por cierre de turno y algunas exclusiones. Esto puede reflejar productos, versiones o documentación distintos; no se usa para afirmar categóricamente que todo Toteat es diferido. [S23](https://toteat.com/es-cl/productos/reportes-y-analisis-en-tiempo-real) [S24](https://toteat.com/es-cl/terminos-y-condiciones)

Los precios de MarketMan difieren entre portada y tarifario específico. El sitio de POS Chile de SumUp también muestra cifras de arriendo que no coinciden literalmente entre secciones. Se evita construir una comparación de costo total con esos importes sin cotización. [S10](https://www.sumup.com/es-cl/punto-de-venta/) [S30](https://www.marketman.com/) [S39](https://www.marketman.com/pricing-for-restaurant-inventory-management-system)

La página comercial SumUp de Tenzo incluye una frase referida a Square; la guía técnica Goodtill es una base más precisa para entender campos y latencia. Este ejemplo refuerza por qué un logo de integración no basta. [S09](https://www.gotenzo.com/integration/sumup/) [S40](https://support.gotenzo.com/integration-guides/sales/guide-goodtillsumup/)

## 17 Conclusión para el proyecto Brewit

La investigación confirma que la categoría existe y que el problema tiene proveedores. También identifica interfaces públicas suficientemente ricas en Toteat para investigar un SaaS complementario sin acceso a su base privada. La posibilidad de construir sobre todo el universo SumUp queda abierta, pero condicionada a familia de POS, país y acceso a órdenes completas.

Recomiendo construir desde la experiencia operativa de Brewit una solución de rentabilidad para cafeterías, con cinco ventajas que deben demostrarse: implantación rápida, recetas correctas ante modificaciones, inventario fácil de mantener, cifras reconciliables y acciones útiles. Usar Toteat para validar producto y demanda; tratar SumUp como una expansión específica cuya viabilidad se prueba antes de prometerla.

La decisión de continuar será sólida si negocios externos pagan, usan las rutinas y obtienen valor medible. Si la integración solo entrega cobros, si los clientes no mantienen los datos o si un add-on existente resuelve mejor el problema al mismo costo, corresponde cambiar el alcance o integrar ese servicio en lugar de duplicarlo.

## 18 Fuentes y documentos revisados

Todas las fuentes siguientes se consultaron el 17 de septiembre de 2026. Las páginas de producto y precios son declaraciones del fabricante; las guías técnicas y archivos OpenAPI respaldan interfaces documentadas, no pruebas de producción. Las rutas YAML de Toteat se leyeron directamente desde el portal público enlazado en S15.

- [S01 Toteat Academy Inventario avanzado](https://learning.toteat.com/product/introduccion-a-inventarios-toteat) - recetas subrecetas compras producción bodegas y conteos.
- [S02 Goodtill módulos](https://support.thegoodtill.com/modules) - stock avanzado y módulos adicionales.
- [S03 Goodtill ingredientes](https://support.thegoodtill.com/ingredientsetup) - relación con productos variantes y modificadores.
- [S04 Goodtill producción](https://support.thegoodtill.com/support/production-events) - transformación de ingredientes y costo de preparación.
- [S05 Goodtill órdenes de compra](https://support.thegoodtill.com/advanced-stock-purchase-orders) - pedido unidades y recepción.
- [S06 MarketMan integración SumUp](https://www.marketman.com/partner/sumup) - integración publicada y regiones declaradas.
- [S07 Goodtill KitchenCUT](https://support.thegoodtill.com/support/kitchencut) - flujo diario campos SKU y modificadores.
- [S08 Apicbase ficha Goodtill](https://partners.apicbase.com/integrations/goodtill) - ficha de integración; profundidad técnica no accesible en texto.
- [S09 Tenzo integración SumUp](https://www.gotenzo.com/integration/sumup/) - propuesta de reporting y previsión.
- [S10 SumUp Punto de Venta Chile](https://www.sumup.com/es-cl/punto-de-venta/) - catálogo inventario ventas y oferta local.
- [S11 SumUp cafeterías Chile](https://www.sumup.com/es-cl/tipos-de-negocios/cafeterias/) - órdenes mesas caja descuentos y stock anunciados.
- [S12 Goodtill API](https://support.thegoodtill.com/support/api) - acceso de tienda autenticación y alcance.
- [S13 Tiller portal API](https://tiller-api.readme.io/) - aviso de retiro y cierre de nuevas integraciones.
- [S14 SumUp POS Pro V3 introducción](https://tillersystems-v3.readme.io/reference/introduction-1) - aviso de retiro también en V3.
- [S15 Toteat portal y OpenAPI](https://developers.toteat.com/) - índice público de interfaces; archivo principal `toteatApi_v2.yaml`.
- [S16 SumUp transacciones](https://developer.sumup.com/api/transactions) - detalle de pagos y productos opcionales.
- [S17 SumUp OpenAPI público](https://github.com/sumup/sumup-developer/blob/main/openapi.json) - superficie pública de endpoints.
- [S18 SumUp autorización](https://developer.sumup.com/tools/authorization/) - API keys y OAuth para multicomercio.
- [S19 SumUp Register UK](https://www.sumup.com/en-gb/pos-register/) - oferta actual y planes POS.
- [S20 SumUp sitio estadounidense](https://www.sumup.com/en-us/) - cifra global de comercios declarada.
- [S21 Goodtill back office](https://support.thegoodtill.com/back-end) - catálogo alérgenos usuarios stock y asistencia.
- [S22 Toteat inventario Chile](https://toteat.com/es-cl/productos/control-de-inventarios-y-stock) - alcance funcional anunciado.
- [S23 Toteat reportes Chile](https://toteat.com/es-cl/productos/reportes-y-analisis-en-tiempo-real) - reportes y comparaciones anunciados.
- [S24 Toteat condiciones Chile](https://toteat.com/es-cl/terminos-y-condiciones) - separación básico avanzado y condiciones de Analytics.
- [S25 Goodtill stock preguntas frecuentes](https://support.thegoodtill.com/advanced-stock-faqs) - conteos y operación del módulo.
- [S26 Goodtill reportes de stock](https://support.thegoodtill.com/advanced-stock-reports) - recibido vendido merma transferencias y variaciones.
- [S27 Toteat escritura de compras](https://developers.toteat.com/paths/create_purchase_movements.yaml) - entrada de facturas y efecto sobre inventario.
- [S28 Toteat eventos de transferencias](https://developers.toteat.com/webhooks/transfer_webhooks.yaml) - requisitos y estados multilocal.
- [S29 Apicbase plataforma](https://get.apicbase.com/) - gestión de alimentos y bebidas multilocal.
- [S30 MarketMan plataforma](https://www.marketman.com/) - alcance funcional y discrepancia de precios con tarifario.
- [S31 Goodtill Planday](https://support.thegoodtill.com/support/planday) - ventas netas por hora y condiciones.
- [S32 Goodtill Rotaready](https://support.thegoodtill.com/rotaready) - turnos asistencia e integración.
- [S33 Toteat Defontana](https://toteat.com/productos/integraciones/integraciones-detalle/defontana) - integración contable publicada.
- [S34 Toteat Softland Chile](https://toteat.com/productos/integraciones/integraciones-detalle/softland-chile) - integración ERP publicada.
- [S35 Toteat Odoo](https://toteat.com/productos/integraciones/integraciones-detalle/odoo) - integración publicada.
- [S36 FoodDocs](https://www.fooddocs.com/) - inocuidad trazabilidad registros y sensores.
- [S37 UpKeep](https://upkeep.com/) - mantenimiento activos y procedimientos.
- [S38 Goodtill Xero](https://support.thegoodtill.com/support/xero-add-on) - exportación contable por cierres y mapeos.
- [S39 MarketMan precios](https://www.marketman.com/pricing-for-restaurant-inventory-management-system) - planes actuales EDI y API.
- [S40 Tenzo guía técnica Goodtill](https://support.gotenzo.com/integration-guides/sales/guide-goodtillsumup/) - campos frecuencia y límites del conector.
- [S41 MarginEdge precios](https://www.marginedge.com/pricing/) - US$350 por local y alcance.
- [S42 Supy](https://supy.io/) - inventario y gestión multilocal.
- [S43 Nory](https://www.nory.ai/) - gestión operativa asistida por IA.
- [S44 Restaurant365](https://www.restaurant365.com/) - suite de gestión de restaurantes.
- [S45 WISK](https://www.wisk.ai/) - inventario y control de bebidas y alimentos.
- [S46 Chift SumUp](https://www.chift.eu/integrations/sumup) - ficha de conector publicado.
- [S47 Chift Tiller](https://www.chift.eu/tools/tiller) - ficha publicada; continuidad por validar.
- [S48 Toteat ventas](https://developers.toteat.com/paths/sales.yaml) - granularidad turnos notas de crédito y límites.
- [S49 Toteat inventario](https://developers.toteat.com/paths/inventorystate.yaml) - saldos y movimientos por período.
- [S50 Toteat catálogo](https://developers.toteat.com/paths/products.yaml) - productos categorías extras y activos.
- [S51 Toteat recaudación](https://developers.toteat.com/paths/collection.yaml) - cajas métodos de pago y fecha comercial.
- [S52 Toteat cancelaciones](https://developers.toteat.com/paths/orders_cancellation_report.yaml) - ruta de cancelaciones.
- [S53 Toteat documentos fiscales](https://developers.toteat.com/paths/fiscaldocuments.yaml) - ruta de documentos.
- [S54 Toteat configuración API](https://developers.toteat.com/tags/config_tag.yaml) - token permisos y habilitación.
- [S55 Toteat esquemas de datos](https://developers.toteat.com/components/schemas.yaml) - entidades y semántica de campos.
- [S56 Toteat webhook de órdenes](https://developers.toteat.com/webhooks/order_webhooks.yaml) - alcance normal y global.
- [S57 Toteat configuración de webhooks](https://developers.toteat.com/tags/webhooks_tag.yaml) - entrega autenticación y reintentos.
- [S58 Goodtill webhooks](https://support.thegoodtill.com/support/webhook) - eventos verificación y sincronización.
- [S59 SumUp integraciones Chile](https://www.sumup.com/es-cl/integraciones/) - SDKs y Cloud API orientados a pagos.
- [S60 Toteat catálogo de integraciones](https://toteat.com/es-cl/productos/integraciones) - directorio de proveedores; confirmar alcance local.

