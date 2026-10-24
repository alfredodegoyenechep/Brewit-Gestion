# Plan de correcciones derivado de la auditoría

Propuestas listas para convertir en cambios separados. Ninguna corrección de producto se aplicó durante el diagnóstico. Los límites de proveedores y accesos nuevos no se suponen resueltos.

Estado posterior a la implementación: [correcciones aplicadas, mediciones y dependencias pendientes](IMPLEMENTACION_CORRECCIONES.md).

## Entrega 1: consistencia de resultados

### C01 — Impedir respuestas financieras atrasadas (P1)

Usar un identificador creciente de solicitud y una clave de todos los filtros aplicados. Solo la solicitud vigente puede publicar datos, mensajes, errores o habilitar botones. Cancelar la anterior cuando sea posible; la secuencia sigue siendo necesaria si cancelar llega tarde. Mantener separados filtros elegidos y filtros del resultado disponible.

**Aceptación:** repetir el caso de salir/volver y respuesta antigua a 400 ms frente a nueva a 40 ms; el período nuevo y sus datos permanecen, incluso si la respuesta antigua termina con error. Exportación y detalle conservan el mismo resultado. Extender el control a compras/ingredientes/productos después de probar sus rutas, sin declarar esos defectos ya reproducidos.

### C02 — Distinguir duplicado de corrección en Mercado Pago (P1)

Conservar la identidad por cuenta/local, `SOURCE_ID`, tipo e instante; añadir comparación de contenido normalizado. Registro idéntico: no incorporar. Misma identidad y contenido distinto: registrar conflicto/corrección, conservar evidencia anterior y publicar una versión que sustituya únicamente ese registro cuando la precedencia del reporte esté validada. Si no puede establecerse qué versión es posterior, conservar el resultado previo con advertencia explícita y revisión pendiente; no elegir por orden casual de descarga.

No reemplazar todo un archivo ni un período completo para corregir una fila. Mantener la importación atómica entre locales y una ruta de revisión histórica que alcance fechas anteriores al punto de avance.

**Aceptación:** 1.000 → 900 con la misma identidad debe mostrarse como corrección validada o conflicto explícito, nunca como duplicado idéntico. Probar fees corregidos, CSV reordenado, reportes superpuestos, identidad compartida entre locales, reversos y fallo en el segundo archivo. Conciliar el total publicado y conservar el original de ambas versiones.

### C03 — Revisiones históricas manuales explícitas (P1)

Conservar modo manual. Ofrecer «Actualizar recientes» y «Revisar período anterior» con local, fuentes, rango y alcance visibles antes de iniciar. La revisión debe cubrir las ventanas completas que contienen el período y explicar que el trabajo será mayor. Reutilizar las capacidades completas existentes; especificar la extensión del contrato para períodos selectivos en el cambio que las implemente.

Registrar fecha/cobertura de la última revisión completa por fuente. No mostrar una revisión diaria como vigente si depende de un programador desactivado. Para Mercado Pago, no limitar una revisión histórica por la última fecha importada.

**Aceptación:** corrección y eliminación fuera de las ventanas recientes aparecen después de revisar ese período; los otros períodos no se duplican. Sin actualización solicitada, navegar no conecta a los proveedores.

## Entrega 2: procesamiento y disponibilidad del servidor

### C04 — Eliminar lecturas y conversiones repetidas (P1)

Introducir un contexto de lectura por cálculo, con filas normalizadas reutilizables y caché por identidad de blob/versión, opciones de fechas y alcance. Mantener inmutabilidad o copias solo donde el consumidor realmente modifica los datos. Reservar reconstrucción de XLSX para consumidores que la necesitan y exportaciones; no retirar compatibilidad antes de verificar fechas, fórmulas, números y cabeceras.

En proyección, cargar ventas una vez por local y reutilizar el contexto para los intervalos de corrección; agrupar intervalos iguales y calcular componentes agregables sin volver a abrir todo el libro. Conservar tomas físicas, límites de días, sustituciones, packaging, consumos internos y unidades.

**Aceptación:** mismos resultados y cobertura del snapshot auditado, y pruebas de límites/compensaciones aprobadas. Cada fuente se decodifica como máximo una vez por combinación de opciones dentro del cálculo. Mostrar antes/después con cinco muestras comparables de proyección, ingredientes y resultados. No prometer una reducción porcentual antes de implementar y medir.

### C05 — Evitar que un cálculo largo retenga las consultas livianas (P1)

Después de reducir trabajo redundante, ejecutar el cálculo que siga siendo largo fuera del hilo HTTP principal o dividirlo en unidades que cedan control de forma efectiva. Reutilizar el patrón de trabajos existente donde corresponda, con progreso por etapas reales, una ejecución por clave, cancelación y resultado asociado a fuentes/filtros.

La respuesta anterior puede seguir consultándose con su corte visible. Desconectar el navegador no debe dejar indefinidamente cálculos que ya no se necesitan. No paralelizar sin límite trabajos grandes que compiten por memoria.

**Aceptación:** probar las órdenes concurrentes desde un proceso independiente. La ruta liviana no debe esperar a que termine todo el reporte; validar también cancelación, error y agotamiento controlado de memoria. Reportar mediana/rango de ambas solicitudes y memoria máxima.

### C06 — Separar consulta, invalidación y reconstrucción de inventario (P2)

`stock.current()` debe poder informar versión y dependencias sin reconstruir durante una consulta de estado. Si las dependencias cambiaron, marcar el resultado anterior y ofrecer/iniciar el recálculo únicamente conforme a la acción explícita autorizada. No presentar el libro anterior como actualizado. Definir el mismo comportamiento para instantáneas vencidas de abastecimiento y órdenes.

**Aceptación:** cambiar una fuente en un fixture no provoca reconstrucción al abrir estado/listado. El usuario ve la diferencia de vigencia; al recalcular obtiene los mismos saldos del comportamiento validado. Guardar criterios no vuelve a leer movimientos.

## Entrega 3: conexiones y trabajo externo

### C07 — Reutilizar contexto y documentos dentro de un trabajo TotEat (P2)

Compartir una captura coherente de catálogo/jerarquías/bodegas y sesión por local durante el trabajo completo. Consultar tomas una vez y reutilizarlas en las dos publicaciones necesarias. Conservar revisiones de autenticación e identidad; no compartir sesiones entre cuentas por conveniencia.

Aplicar incrementalidad a recepciones y movimientos solo con una política que capture correcciones, eliminaciones, pendientes y recepciones tardías. Priorizar reutilización dentro del mismo trabajo, que no exige suponer un endpoint de cambios inexistente.

**Aceptación:** contar solicitudes por fuente/ventana antes y después. Una actualización completa no repite la misma toma o maestro dentro del mismo corte. Mantener equivalencia de documentos, cantidades, bodegas y saldos ante fallos y reintentos.

### C08 — Resolver contrato y vigencia de acceso TotEat (P2; dependencia externa)

Conseguir confirmación del alcance de cuota y autenticación soportada para maestros/documentos. Mantener 21 segundos hasta contar con evidencia para cambiarlo. Mostrar la vía efectivamente utilizada y credenciales pendientes de renovación; actualizar la documentación que describe un mecanismo alternativo diferente al código actual.

Instrumentar cada trabajo con espera de cola, inicio/fin de solicitud, tamaño y filas recibidas, validación, normalización y publicación; sin tokens ni parámetros secretos. Usar esa evidencia para decidir concurrencia por cuenta/local y reintentos acotados.

**Aceptación:** prueba documentada de vigencia, identidad y cobertura de ambos locales; 401/403/429/timeout dejan estado claro y versión anterior disponible. Solo aplicar paralelismo respaldado por el contrato.

### C09 — Piloto de API oficial de reportes Mercado Pago (P2; acceso pendiente)

Obtener un token autorizado y comenzar por listar/descargar reportes ya existentes. Comparar exactamente el reporte actual por cuenta, local, moneda, fechas, campos e importes. Registrar identificador y versión/huella de reporte para evitar descargas repetidas cuando pueda demostrarse que no cambió.

Si la API no permite obtener campos necesarios o demostrar vigencia, conservar el mecanismo actual con diagnóstico explícito. No generar reportes ni cambiar su programación como parte de una prueba de lectura sin definir ese alcance.

**Aceptación:** paridad fila a fila y de totales en al menos un período cerrado y uno reciente, incluyendo devolución y corrección. Probar credencial vencida, reporte pendiente, superposición y conservación de versión. Sustituir navegador únicamente después de esa validación.

## Entrega 4: interacción y navegación

### C10 — Seleccionar filtros antes de procesar (P2)

Aplicar el patrón de consulta explícita a resultados financieros, ingredientes y compras; revisar costos y otras vistas con sus mediciones. Conservar filtros locales inmediatos. Reutilizar resultados al volver si su clave de filtros, reglas y fuentes coincide. Agregar estado inicial visible en Datos y sincronización.

**Aceptación:** cambiar local y dos fechas no hace tres cálculos; Consultar realiza uno con los valores finales. Carga, resultado anterior, error y cobertura parcial son comprensibles. Los cambios de filtro no ocultan un resultado anterior bajo una etiqueta nueva.

### C11 — Navegación por tareas y claridad de acciones (P3)

Validar el mapa de [PROPUESTA_UI.md](PROPUESTA_UI.md) y el [esquema](PROPUESTA_UI.html) con los seis recorridos de administración. Renombrar los análisis ambiguos, reunir inventario/compras y ofrecer acceso directo a órdenes sin cálculo previo. Mantener funciones existentes y distinguir la operación en preparación.

**Aceptación:** cada función actual tiene destino y acceso; local/período se conservan al pasar a detalles; teclado, foco, tamaños de letra y tablas siguen utilizables. Registrar observaciones de la sesión de uso, sin afirmar mejoras de éxito no medidas.

### C12 — Corregir el selector de la prueba de Control histórico (P3)

Limitar la búsqueda «Promedio diario» al panel histórico activo; no cambiar el texto de producto para satisfacer una prueba ambigua.

**Aceptación:** la prueba falla si falta el indicador del panel y pasa aunque exista un encabezado con el mismo texto en otro modal. Ejecutar el archivo afectado y los recorridos de diálogos pertinentes.

## Dependencias y entrega de cada cambio

C01/C02/C03 preceden cambios que puedan ocultar diferencias. C04 precede la decisión final de C05, para no trasladar trabajo redundante a otro hilo. C07 puede avanzar sin esperar C08; C09 requiere acceso y equivalencia. C10 puede implementarse con cálculos actuales, pero no reemplaza C04/C05. C11 se valida con el dueño antes de reorganizar navegación.

Cada entrega debe incluir reproducción anterior, cambio acotado, pruebas, medición posterior cuando corresponda y forma de volver al comportamiento anterior. Las modificaciones de fuentes conservan registros originales y versiones publicadas; no se descartan históricos para mejorar una medición.
