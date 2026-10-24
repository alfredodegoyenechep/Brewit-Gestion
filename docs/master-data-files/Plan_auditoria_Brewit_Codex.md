# Plan e instrucciones para Codex: auditoría integral de Brewit

Fecha: 24 de octubre de 2026
Propósito: adaptar este plan a la aplicación real, ejecutar la auditoría y entregar un diagnóstico comprobable con mejoras priorizadas.

## 1. Contexto y objetivo

La aplicación administra Brewit: ventas, estado financiero, proyecciones, productos e ingredientes. Obtiene ventas y maestros desde TotEat —mencionado también como Totit— mediante API y/o archivos, y recibe información de pagos desde Mercado Pago.

En general funciona bien. La preocupación principal es comprobar la consistencia de lo que hace y muestra, y determinar si las esperas por cálculos, consultas y recargas son necesarias. La experiencia que se evalúa es la de las personas que administran y operan Brewit; si existe una interfaz para consumidores, incluirla y distinguirla.

Audita funcionalidad, experiencia de uso, interfaz, calidad de datos, procesamiento, almacenamiento, integraciones, seguridad y continuidad. Busca mejoras proporcionales al tamaño y crecimiento del negocio.

La pregunta central es: **¿cada operación se ejecuta cuando corresponde, sobre datos completos y correctos, con un costo razonable y una respuesta comprensible para el usuario?**

## 2. Forma de trabajar y alcance

1. Lee las instrucciones del repositorio, la documentación y las pruebas existentes. Identifica tecnologías, despliegue, bases de datos, tareas programadas, colas, cachés y conectores realmente utilizados.
2. Revisa este plan en ese contexto: indica qué aplica, qué falta y qué debe ajustarse. Después continúa con la auditoría sin detenerte en una propuesta genérica.
3. Recorre la aplicación ejecutada, además de revisar el código. Combina evidencia de interfaz, red, servidor, base de datos y datos de origen.
4. Esta primera tarea es de diagnóstico. Puedes crear informes, pruebas y mediciones en un entorno aislado. Conserva los cambios ajenos y evita modificar el comportamiento del producto durante la auditoría. Entrega las correcciones propuestas como un plan ejecutable posterior.
5. Haz pruebas de fallas, concurrencia y carga en desarrollo o pruebas, con copias controladas o datos sintéticos. En producción utiliza observación y consultas acotadas; no alteres ventas, pagos, maestros ni históricos. No ejecutes cobros, devoluciones, borrados o restauraciones reales.
6. Revisa la configuración y el manejo de credenciales sin mostrar sus valores. Usa referencias anonimizadas en los informes.
7. No supongas que un módulo existe. Identifica los módulos presentes y marca como “no aplica” lo ajeno al producto. Una función deseable que no existe debe separarse de un defecto.
8. Si falta acceso, continúa con lo que puedas comprobar y especifica la limitación, su impacto y el acceso mínimo pendiente. No declares correcto algo que solo se pudo revisar parcialmente.
9. Sustenta los hallazgos con evidencia. Distingue problema confirmado, riesgo inferido y oportunidad de mejora. No presentes una preferencia de diseño como una falla.

## 3. Inventario y mapa del sistema

Entrega un inventario de pantallas, funcionalidades, perfiles y permisos. Para cada módulo identifica:

- Qué tarea permite completar, con qué frecuencia y a qué usuarios.
- Qué información muestra, de dónde proviene y cuándo fue actualizada.
- Qué cálculos, consultas e integraciones dispara al abrirse y al interactuar.
- Qué datos guarda o modifica y qué otros módulos dependen de ellos.

Traza los recorridos desde TotEat, Mercado Pago y archivos hasta los registros normalizados, cálculos, reportes y exportaciones. Identifica cuál es la fuente autorizada de cada dato y cómo se resuelven discrepancias.

Documenta las definiciones financieras y operativas usadas por la aplicación. Si encuentras reglas contradictorias o ambiguas, muestra las alternativas y el impacto; no elijas silenciosamente una nueva regla.

## 4. Funcionalidad y coherencia de los procesos

Comprueba recorridos completos, incluidos resultados, validaciones y recuperación de errores:

- Consultar ventas y resultados por sucursal, período y consolidado.
- Cambiar filtros, navegar al detalle, regresar y exportar.
- Sincronizar por API e importar archivos, según los mecanismos existentes.
- Consultar y mantener productos, ingredientes y recetas cuando corresponda.
- Revisar pagos, conciliaciones y diferencias.
- Consultar y modificar supuestos de proyecciones.
- Revisar inventarios, transferencias y controles históricos si están implementados.

Busca cálculos distintos para el mismo concepto, filtros que no se propagan, permisos que cambian entre pantallas, guardados incompletos y pasos innecesarios.

Prueba sucursales sin actividad, productos nuevos o desactivados, registros incompletos, períodos abiertos y cerrados, y acciones repetidas. Comprueba qué ocurre si dos usuarios modifican el mismo dato y si una operación se interrumpe antes de terminar.

**Criterio:** un mismo concepto debe conservar su definición y resultado entre resumen, detalle, reporte y exportación, para los mismos datos y filtros.

## 5. Datos, cálculos y conciliación

### 5.1 Ventas, resultados y pagos

Verifica las definiciones y los cálculos de venta bruta, descuentos, venta sin impuestos, venta neta, propinas, costos, margen, comisiones y otros conceptos presentes.

- Distingue ventas, pagos cobrados y liquidaciones recibidas. Pueden ocurrir en fechas distintas.
- Revisa anulaciones, devoluciones parciales y totales, pagos pendientes o rechazados y descuentos a nivel de línea y pedido.
- Comprueba que propinas y comisiones se traten según la regla explícita del reporte.
- Evita sumar dos veces una venta porque aparece en TotEat y su pago también aparece en Mercado Pago.
- Verifica pagos divididos entre medios y relaciones entre pedidos, pagos, devoluciones y liquidaciones. No asumas una relación de uno a uno.
- Comprueba el tratamiento de impuestos y redondeos por concepto; no impongas una fórmula única sin verificar el origen.
- Revisa precisión monetaria y errores por aritmética de punto flotante.
- Para márgenes y porcentajes consolidados, comprueba el denominador y la ponderación; no promedies porcentajes de sucursales sin justificarlo.
- Diferencia cero, ausencia de datos, dato pendiente y error de integración.

Construye conciliaciones por sucursal y período: fuente → importación → base normalizada → cálculo → pantalla → exportación. Compara cantidades de registros e importes y explica cada diferencia.

Define una tolerancia solo cuando exista una razón documentada, como un redondeo por línea. Cuantifica su acumulación; no uses tolerancias para ocultar diferencias.

### 5.2 Productos, ingredientes e históricos

- Verifica identificadores estables, duplicados, referencias huérfanas, cambios de nombre y productos distintos con nombres iguales.
- Comprueba que los identificadores externos se interpreten dentro de su fuente, cuenta y sucursal cuando corresponda.
- Revisa unidades y conversiones: gramos/kilos, mililitros/litros, unidades, envases y rendimientos.
- Si existen recetas e inventario, comprueba consumos, mermas, transferencias y cambios de receta o costo.
- Identifica si actualizar un maestro, precio, receta o costo cambia reportes históricos. Determina si ese efecto es intencional y trazable.
- Comprueba que proyecciones distingan hechos reales de supuestos y no se presenten como resultados observados.

### 5.3 Fechas y consistencia temporal

Verifica zona horaria America/Santiago, cambios de horario, día calendario frente a jornada comercial, cortes de semana y mes y operaciones cercanas a medianoche.

Comprueba que las comparaciones usen ventanas equivalentes y señalen los períodos incompletos. Un total, sus componentes y su exportación deben usar el mismo corte de datos o advertir expresamente la diferencia.

Si existe control histórico, distingue registros nuevos, modificados y eliminados entre sincronizaciones. Si no existe, evalúa el riesgo y presenta la propuesta por separado.

**Criterio:** cada indicador relevante puede explicarse y reconstruirse desde sus registros de origen, con reglas y fechas de corte conocidas.

## 6. Auditoría específica de esperas, recargas y cálculos

Esta es una prioridad de la auditoría. No te limites a identificar pantallas lentas: explica sus causas y qué trabajo necesitan realmente.

### 6.1 Medición reproducible

Para los recorridos principales registra:

- Tiempo hasta la primera información útil y hasta completar la acción.
- Tiempo durante el cual el usuario no puede seguir trabajando.
- Cantidad de solicitudes, datos transferidos y errores.
- Tiempo en red externa, servidor, consultas, cálculo y renderizado.
- CPU y memoria cuando sean relevantes.

Mide apertura inicial, navegación repetida con caché disponible, cambio de filtros y regreso a una pantalla, con datos sin cambios y después de una actualización.

Registra entorno, versión del código, volumen, dispositivo, red y número de repeticiones. Si hay suficientes muestras, informa mediana y percentiles 75 y 95; con pocas muestras muestra valores individuales o rangos y declara la limitación.

### 6.2 Matriz obligatoria de esperas

Una fila por espera o proceso relevante:

| Pantalla y acción | Trabajo disparado | Motivo de ejecución | Tiempo observado | Datos utilizados | ¿Bloquea? | ¿Se repite sin cambios? | Causa | Propuesta | Regla de actualización |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Incluye la ubicación en código o consulta que permita verificar la causa.

### 6.3 Preguntas obligatorias

- ¿Navegar o cambiar una pestaña vuelve a sincronizar fuentes o recalcula todos los indicadores?
- ¿Se consulta o calcula información que la pantalla no utiliza?
- ¿Se descarga todo el histórico para mostrar un resumen o pocas filas?
- ¿Existen llamadas duplicadas, consultas por cada fila o ejecuciones repetidas por renderizados?
- ¿Se ejecutan secuencialmente tareas independientes?
- ¿Cambiar varios filtros dispara trabajo para cada valor intermedio?
- ¿Una respuesta antigua puede sobrescribir un filtro más reciente?
- ¿Volver a una pantalla recalcula resultados cuyos datos y reglas no han cambiado?
- ¿Existe recarga automática excesiva cuando la pestaña está oculta o el dato no requiere esa frecuencia?
- ¿Se recalcula todo el histórico cuando solo cambió una sucursal o período?
- ¿Una falla externa bloquea pantallas que ya disponen de información local válida?

Clasifica cada proceso: necesario para la acción actual; necesario solo si cambian sus entradas; diferible; reutilizable; duplicado; o no verificable.

### 6.4 Propuestas condicionadas a la evidencia

Evalúa caché, consultas más acotadas, agregaciones, cálculo incremental, paginación, ejecución en segundo plano, agrupación de cambios de filtros y cancelación o descarte de respuestas obsoletas.

Para cada propuesta especifica dependencias, vigencia, invalidación, errores y consumo adicional de recursos. Las claves de caché deben respetar permisos, sucursal, filtros, período y versión de datos o reglas pertinente. Los cambios históricos también deben invalidar resultados afectados.

Un trabajo en segundo plano necesita estado durable, control de duplicados y una forma de publicar resultados coherentes. Una barra de progreso puede mejorar la comprensión, pero no demuestra que se haya reducido el trabajo.

No exijas que toda consulta vuelva a las fuentes externas. Decide la frecuencia según la necesidad de información y muestra la fecha de actualización. Para datos antiguos, define cuánto tiempo son utilizables y cuándo deben advertirse o bloquear una decisión sensible.

Propón objetivos de tiempo a partir de las mediciones y el uso real. No prometas porcentajes de mejora sin verificarlos ni impongas un tiempo único a pantallas y procesos distintos.

**Criterio:** cada espera tiene una causa y una necesidad identificadas; toda optimización preserva exactitud, permisos y actualidad explícita.

## 7. Experiencia de uso e interfaz

Evalúa las tareas principales con los perfiles reales: administración, operación, finanzas u otros presentes.

- Claridad de navegación, nombres, jerarquía y acciones.
- Número de pasos y pérdida de contexto al entrar y salir de detalles.
- Persistencia de filtros y visibilidad de sucursal, período, moneda, unidad y fecha de actualización.
- Aprovechamiento del espacio, densidad de tablas, encabezados y totales comprensibles.
- Legibilidad en los tamaños de pantalla utilizados; comportamiento al ampliar el texto y al hacer scroll.
- Coherencia de botones, formularios, formatos numéricos y mensajes.
- Navegación por teclado, foco visible, contraste y estados que no dependan solo del color.
- Estados de carga, vacío, error, información parcial y sincronización pendiente.
- Validaciones útiles y recuperación sin perder datos o filtros.
- Prevención de dobles envíos y claridad sobre qué acciones se guardaron.
- Posibilidad de seguir trabajando mientras termina una operación independiente.

Comprueba que los indicadores de carga correspondan al trabajo real, que no existan pantallas vacías o esperas infinitas y que un error indique una acción posible.

Documenta los problemas de uso con recorrido reproducible e impacto. Usa capturas solo si no exponen información sensible; en caso contrario describe o reproduce el caso con datos sintéticos. Las valoraciones subjetivas requieren contraste con tareas o usuarios.

## 8. Procesamiento, base de datos y almacenamiento

### Procesamiento y consultas

Identifica consultas lentas, lecturas innecesarias, índices pertinentes, agregaciones repetidas, bloqueos, exceso de concurrencia, tareas superpuestas y crecimiento de memoria.

Utiliza planes de consulta y perfiles cuando sea posible, con operaciones acotadas. No recomiendes índices, cachés o una nueva arquitectura por intuición: explica el beneficio esperado y su costo de mantenimiento.

Comprueba la consistencia de transacciones y de resultados cuando hay sincronizaciones, consultas y ediciones simultáneas.

### Almacenamiento

Mide tamaño y crecimiento de tablas, índices, archivos importados, respuestas originales, históricos, respaldos, cachés y registros de diagnóstico.

Distingue copias necesarias para trazabilidad y recuperación de duplicación accidental. Revisa limpieza de temporales, caducidad de cachés y retención de registros. Evalúa compresión o archivo de datos antiguos solo si mantienen acceso, conciliación y capacidad de recuperación.

Toda recomendación de eliminación debe identificar dependencia, política de retención y recuperación. No borres información como parte de esta auditoría.

### Escalabilidad y costo

Evalúa el volumen actual y escenarios razonables de más sucursales, más historia y usuarios concurrentes. Explicita supuestos y puntos de saturación. Estima costos solo con tarifas o consumos verificables; de lo contrario entrega los recursos que deben medirse.

**Criterio:** el uso de recursos crece de forma explicable y las mejoras no sacrifican históricos ni reconstrucción de resultados.

## 9. Integraciones con TotEat, Mercado Pago y archivos

Inspecciona el conector real y contrástalo con la documentación aplicable a los endpoints utilizados. No supongas que todos ofrecen los mismos filtros, cuotas, actualizaciones incrementales o notificaciones.

Verifica:

- Autenticación, permisos mínimos, expiración y renovación cuando corresponda.
- Tiempos máximos de conexión y respuesta.
- Reintentos limitados para fallas transitorias, espera progresiva y respeto de límites del proveedor.
- Tratamiento distinto de credenciales inválidas, permisos, límites de consumo y errores de servidor.
- Paginación completa y estable, campos obligatorios y cambios de formato.
- Detección de datos incompletos aunque la respuesta HTTP sea exitosa.
- Manejo de correcciones retroactivas, anulaciones y registros tardíos.
- Claves estables para evitar duplicados al reintentar o combinar API y archivos.
- Regla de precedencia si un registro llega por más de un canal.
- Puntos de reanudación que no se adelanten sobre páginas fallidas.
- Exclusión o coordinación de sincronizaciones simultáneas.
- Validación previa y publicación coherente: no presentar una importación parcial como completa.

Para archivos, prueba variantes reales de columnas, tipos, separadores, codificación, fechas, decimales y ceros iniciales. Un rechazo debe indicar archivo, fila, campo y motivo sin exponer datos innecesarios.

Si hay webhooks, comprueba autenticidad según el tipo de notificación, duplicados, eventos fuera de orden y consulta del estado vigente cuando corresponda. No agregues un mecanismo que el producto no usa como requisito para aprobarlo.

Muestra por fuente y sucursal: última ejecución, último período completo, estado, registros procesados y diferencias. La aplicación debe distinguir éxito, resultado parcial y falla, conservar el último conjunto válido cuando sea posible y permitir una recuperación controlada.

**Criterio:** repetir o reanudar una sincronización no duplica operaciones ni pierde información; un corte de la fuente es visible y no se interpreta como ventas cero.

## 10. Seguridad y continuidad operativa

Revisa controles proporcionales al sistema:

- Autenticación, sesiones y permisos aplicados en el servidor.
- Acceso a sucursales, reportes, archivos y exportaciones mediante identificadores manipulados.
- Credenciales fuera del código cliente, repositorio y registros de diagnóstico.
- Validación de entradas y archivos; consultas y descargas protegidas.
- Dependencias y vulnerabilidades explotables en el contexto real.
- Registro de cambios relevantes: quién, cuándo, qué cambió y origen.
- Respaldo de datos y configuración; cobertura, frecuencia y acceso.
- Restauración ensayada en un entorno aislado, cuando exista el acceso necesario.
- Tiempo de recuperación y cantidad de datos que podrían perderse, medidos o explicitados como pendientes.
- Detección de integraciones detenidas, tareas fallidas y datos desactualizados.

Una revisión estática o un escáner por sí solos no certifican seguridad ni capacidad de recuperación. Declara qué controles se comprobaron y cómo.

## 11. Pruebas mínimas de aceptación

Adapta los datos y recorridos a la aplicación real. Las pruebas deben verificar resultados de negocio, no copiar la implementación.

| Escenario | Resultado esperado |
| --- | --- |
| Misma sincronización o archivo ejecutado dos veces | No duplica ventas, pagos ni movimientos. |
| Corte en una página de la importación y reanudación | No pierde registros ni publica el período como completo antes de tiempo. |
| Fuente no disponible o respuesta incompleta | Error o estado parcial visible; no sustituye cifras válidas por ceros. |
| Corrección retroactiva de una venta | Actualiza lo pertinente, deja trazabilidad e invalida cálculos afectados. |
| Cambio rápido de sucursal y período | Solo presenta resultados correspondientes a la selección vigente. |
| Regreso a una pantalla sin cambios en entradas | Reutiliza resultados cuando sea válido; cualquier repetición tiene justificación. |
| Anulación, devolución y pago dividido | Ventas, cobros y liquidaciones conservan sus definiciones y concilian. |
| Cambio de nombre, receta o costo | Histórico consistente con la política explícita del negocio. |
| Datos próximos a medianoche o cambio de horario | Períodos y comparaciones coinciden con el corte definido. |
| Dos usuarios o procesos actuando simultáneamente | No hay duplicados, pérdida silenciosa de cambios ni publicación incoherente. |
| Usuario sin acceso a una sucursal | Restricción efectiva también por API y exportaciones. |
| Resumen, detalle y exportación del mismo corte | Totales conciliables y diferencias explicadas. |
| Recuperación de respaldo en pruebas | Se verifica integridad y se mide el tiempo de recuperación. |

Si un escenario no aplica, justifica por qué. Si no se puede ejecutar, márcalo como pendiente y no como aprobado.

## 12. Entregables

Entrega los informes en el repositorio o carpeta de trabajo, respetando sus convenciones:

1. **AUDITORIA_BREWIT.md**
   - Resumen ejecutivo comprensible para el dueño del negocio.
   - Contexto técnico descubierto y ajuste de este plan.
   - Cobertura: módulos revisados, métodos, entornos y limitaciones.
   - Hallazgos por área y evidencia.
   - Línea base de rendimiento y volumen.
   - Recomendaciones y secuencia de implementación.
   - Riesgos pendientes y qué se necesita para resolverlos.

2. **HALLAZGOS_BREWIT.csv**
   - Identificador, área, módulo, estado de evidencia, severidad, prioridad, impacto, frecuencia o probabilidad.
   - Pasos de reproducción, esperado, observado y causa.
   - Evidencia y ubicación en código.
   - Propuesta, esfuerzo estimado, dependencias, riesgo del cambio y prueba de aceptación.

3. **MATRIZ_ESPERAS_BREWIT.csv**
   - La matriz del apartado 6, con mediciones y motivos de actualización.

4. **MATRIZ_RECONCILIACION_BREWIT.csv**
   - Fuente, sucursal, período, corte, concepto, valor esperado, valor observado, diferencia, explicación y evidencia.

Adjunta únicamente las pruebas y mediciones necesarias para reproducir los hallazgos, anonimizadas y sin secretos. Evita informes extensos de herramientas sin interpretación.

Para cada área usa: “conforme dentro de lo probado”, “con observaciones”, “riesgo alto” o “no verificable”. No promedies puntuaciones para ocultar un problema crítico.

## 13. Priorización y siguiente etapa

Ordena las correcciones por daño potencial, frecuencia, alcance, evidencia, beneficio y esfuerzo:

- **P0:** exposición grave, pérdida o corrupción de datos, cifras materiales incorrectas o interrupción crítica comprobada. Comunicar de inmediato.
- **P1:** afecta una tarea esencial o puede generar decisiones equivocadas de forma relevante.
- **P2:** mejora importante de rendimiento, confiabilidad o usabilidad sin el impacto anterior.
- **P3:** refinamiento de baja incidencia o mejora opcional.

Distingue severidad del problema y orden de ejecución: una dependencia puede cambiar la secuencia. Presenta soluciones rápidas, cambios intermedios y cambios estructurales solo cuando estén justificados.

No asignes fechas ni ahorros de precisión ficticia. Señala qué estimaciones necesitan validación.

Para cada corrección futura define cómo comprobar antes y después, con los mismos datos, que mejora el objetivo y conserva resultados, permisos e históricos. Incluye una forma de revertir cambios de riesgo.

## 14. Instrucción de inicio

**Empieza inspeccionando la aplicación y su repositorio. Ajusta este plan a lo que realmente existe y ejecuta la auditoría hasta donde permitan los accesos. Prioriza la consistencia financiera, las integraciones y todas las esperas del usuario. Entrega hallazgos comprobados, limitaciones explícitas y un plan de correcciones.**

## Referencias técnicas de apoyo

Estas referencias orientan la auditoría; no sustituyen el contexto real ni implican una certificación de cumplimiento.

- Google, diagnóstico de interacciones lentas: https://web.dev/articles/optimize-inp
- W3C, accesibilidad WCAG 2.2: https://www.w3.org/TR/WCAG22/
- OWASP, requisitos verificables de seguridad ASVS: https://asvs.owasp.org/
- Mercado Pago, ejemplo oficial de tratamiento seguro e idempotente de notificaciones: https://mercadopago.github.io/sdk-php/docs/webhooks.html

Al revisar integraciones, utiliza además la documentación vigente del endpoint, producto y modalidad efectivamente utilizados.

