# Navegación y experiencia de uso

La revisión se centra en la administración que realiza el dueño. Se inspeccionaron las 17 entradas de navegación, los manejadores de sus filtros y ocho aperturas repetidas en navegador. Es una evaluación técnica y heurística con datos locales; no sustituye una sesión de usabilidad observando al usuario.

## Hallazgos de interacción

1. **Hay mensajes de carga en muchas pantallas.** Compras, ingredientes, costos, resultados financieros, ventas e inventario los configuran al comenzar. No se confirma una ausencia generalizada. Sí hay una ausencia específica al comenzar `loadUploadOverview`: no establece un estado inicial de carga; con respuesta demorada quedan visibles el vacío o datos anteriores.
2. **Navegar puede volver a ejecutar un cálculo amplio.** Entrar a resultados financieros llama al cálculo inmediatamente, aun cuando el usuario vaya a cambiar local o período. Volver a la misma vista repite la consulta. Abastecimiento ya ofrece un patrón mejor para este caso: presenta filtros y espera «Actualizar».
3. **Dos cambios de fecha generan dos consultas de compras.** Se reprodujo con eventos `change` reales: una consulta con la primera combinación y otra con la combinación final. En ingredientes también hay cargas ligadas a ambos campos de fecha; en costos al local y fecha. No hace falta multiplicar cálculos mientras se prepara la selección.
4. **Hay filtros correctamente locales.** Proveedor/administrados/necesidades en abastecimiento y diversos filtros de presentación ya reutilizan datos. Mantenerlos inmediatos.
5. **Una respuesta antigua puede reemplazar un resultado nuevo.** Se reprodujo con respuestas invertidas en resultados financieros para el mismo local y períodos diferentes. La comprobación de local no protege el período; volver a la vista permite nuevas cargas mientras una anterior sigue en curso.
6. **«Actualizar» y «API» describen acciones diferentes según la pantalla.** Algunas acciones recalculan fuentes guardadas; otras consultan TotEat, incluyendo servicios que dependen de una sesión web. «Actualizar datos vía API» sugiere una única vía y no muestra el alcance antes de comenzar. El usuario necesita saber qué información actualizará y de qué local; los detalles del protocolo pueden quedar en un desplegable técnico.
7. **La navegación ofrece dos opciones difíciles de distinguir:** «Análisis y Estadísticas» y «Análisis de la Venta». Ambas pertenecen al análisis comercial, pero sus nombres no explican qué pregunta responde cada una.

## Navegación propuesta, sin eliminar funciones

| Grupo propuesto | Entradas actuales incluidas | Propósito |
| --- | --- | --- |
| Ventas y resultados | Resumen General Ventas; Resultados Financieros; Resultados Semanales / Mensuales | Revisar el negocio y sus diferencias. Mantener el resumen como inicio. |
| Análisis de ventas | Análisis y Estadísticas → «Estadísticas por producto y horario»; Análisis de la Venta → «Demanda y oportunidades»; Ventas por Ingredientes | Distinguir análisis descriptivo, oportunidades y consumo asociado. |
| Inventario y compras | Inventario; Compras; Proyección de Compras | Consultar disponibilidad, documentos y reposición. Añadir acceso directo a órdenes guardadas, sin calcular proyección para acceder. |
| Productos y costos | Productos; Ingredientes; Costos por Revisar | Mantener maestros y entender costos. |
| Control y configuración | Hallazgos; Auditoría Transacciones; Datos y sincronización; Control histórico; Configuración | Investigar problemas, revisar fuentes y administrar. «Operación Brewit · Preparación» continúa identificado como preparación y separado de la operación habitual. |

Es una propuesta de organización basada en tareas. No implica nuevos permisos ni ocultar funcionalidades. Los nombres definitivos deberán comprobarse con una sesión corta de uso antes de implementarlos.

## Recorridos actuales y propuestos

| Tarea | Fricción actual | Recorrido propuesto |
| --- | --- | --- |
| Entender una variación | Elegir entre tres entradas de análisis con nombres amplios; cambiar filtros puede recargar antes de terminar | Resumen → indicador/detalle → análisis correspondiente, conservando local, período y corte. |
| Revisar margen o costo | Resultados se calcula al entrar; luego se cambia el período y se vuelve a calcular | Elegir local/período → Consultar → abrir desglose del mismo resultado. |
| Explicar inventario | Pantallas mezclan fuentes, documentos y acciones de cálculo | Inventario → selección de alcance → Consultar/Recalcular con datos guardados; actualización externa diferenciada. |
| Abrir una orden pasada | Acceso situado dentro de abastecimiento, aunque leer una orden no necesita calcularlo | Inventario y compras → Órdenes guardadas → abrir. Mantener también el acceso actual. |
| Verificar actualización | Información repartida entre fechas, estados y frecuencias; el primer acceso no indica carga | Datos y sincronización → estado por fuente/local → Actualizar la selección. Frecuencias automáticas quedan fuera de la acción habitual, coherente con el modo manual acordado. |
| Investigar una diferencia | Hallazgos y auditoría transaccional aparecen en grupos distintos | Control → incidencia → detalle, con retorno a los mismos filtros y al mismo resultado. |

No se inventaron cantidades de clics ni tasas de éxito del usuario. Los recorridos describen accesos y manejadores observados; medir tiempo humano requiere una sesión de tareas.

## Contrato de filtros y carga recomendado

- Mantener separados **filtros elegidos** y **filtros del resultado mostrado**. Cuando difieran, indicar «Filtros modificados: pulsa Consultar» junto al resultado anterior.
- Reservar **Consultar** para obtener un resultado con fuentes guardadas y **Actualizar fuentes** para conectar externamente. Usar **Recalcular** cuando se reconstruya inventario/Kardex. Cada botón debe indicar su alcance, sin exigir conocimiento de APIs.
- Mantener filtros visuales inmediatos cuando el conjunto cargado ya contiene los datos necesarios.
- Mostrar respuesta visual en el primer ciclo de renderizado, antes de iniciar trabajo pesado. En trabajos largos, indicar etapa real y tiempo transcurrido; no simular porcentajes.
- Usar estados coherentes: pendiente de consulta, cargando, resultado vigente, resultado anterior, cobertura parcial, sin datos y error. Mantener «sin datos» separado de cero.
- Deshabilitar solo acciones incompatibles. Permitir navegar y, cuando sea técnicamente posible, cancelar. Una cancelación debe llegar al trabajo del servidor; abortar únicamente la respuesta no elimina el costo de un cálculo síncrono ya iniciado.
- Identificar solicitudes por una secuencia y combinación completa de filtros; impedir que respuestas antiguas cambien datos, mensajes o botones de la solicitud vigente.
- Detalles y exportaciones deben conservar el identificador/corte del resultado mostrado.

## Presentación y accesibilidad

Mantener colores, escalado de letra y componentes existentes. Priorizar cabeceras legibles, unidades explícitas, alineación de cantidades y dinero, y separación entre acciones de consulta y edición. Las tablas de fuentes y abastecimiento necesitan un resumen de estado siempre visible y detalle horizontal conservando identidad del producto/local.

La aplicación ya tiene numerosos `aria-live` y usa diálogos. Verificar su uso en cada operación nueva: foco inicial y de retorno, Escape, controles con nombre accesible y mensajes no dependientes solo del color. La prueba existente de detalles/exportación verificó recorridos accesibles; esta revisión no declara conformidad WCAG completa.

El [esquema navegable](PROPUESTA_UI.html) muestra tres conceptos: filtros antes de consultar, estados de carga y actualización manual por fuente. Es un artefacto de revisión con datos demostrativos; no está conectado al producto.
