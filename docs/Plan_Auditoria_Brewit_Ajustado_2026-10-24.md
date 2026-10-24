# Auditoría de Brewit: fuentes externas, tiempos de carga y experiencia de uso

Fecha: 24 de octubre de 2026. Plan ajustado a las prioridades acordadas y ejecutado sobre código, registros existentes y una copia aislada de datos.

**Resultado:** [informe de auditoría](auditoria/2026-10-24/AUDITORIA_BREWIT.md). Las comprobaciones que requieren acceso adicional a proveedores están identificadas como pendientes; no se presentan como aprobadas.

## Objetivo y decisiones acordadas

Explicar por qué demora cada operación, qué trabajo es necesario y cómo simplificar el uso para la administración del dueño. Prioridades, en este orden:

1. Conexión y procesamiento de TotEat, con detalle por fuente.
2. Conexión de Mercado Pago y cargas de pantallas.
3. Organización y claridad de la interfaz.

El comportamiento objetivo es actualizar todas las fuentes externas por solicitud del usuario. Abrir vistas debe utilizar los datos disponibles, mostrando su vigencia. Los filtros de presentación se mantienen inmediatos; los que exigen procesamiento amplio se preparan antes de consultar. El diagnóstico comprobó que las programaciones guardadas ya están desactivadas.

La auditoría no modifica conectores, cálculos, navegación, APIs ni esquemas. Esos cambios se presentan en un plan posterior. La exactitud, los permisos y la conservación de evidencia son controles transversales; PostgreSQL operativo en preparación y una auditoría completa del despliegue quedan fuera de estas prioridades.

## Trabajo de auditoría

### 1. Preparar evidencia reproducible

Identificar versión de código y cambios locales, configuración no sensible, cobertura de fuentes y volúmenes. Crear una copia privada sin credenciales ni sesiones reutilizables. Desactivar sincronizadores y mantenimiento, bloquear consultas externas en las mediciones y utilizar fuentes sintéticas para las pruebas de fallos.

### 2. Investigar TotEat por fuente

Mapear ventas, pagos, anulaciones, compras, recepciones, maestros, bodegas, inventarios, tomas, transferencias y transformaciones. Distinguir API pública, servicios internos autenticados, navegador y descargas. Separar archivos recibidos de archivos generados por Brewit.

Medir espera de cola, número/rango de consultas, procesamiento y publicación donde exista instrumentación suficiente. Revisar ventanas incrementales, historia antigua, anulaciones, repetición de documentos, credenciales y reutilización. Contrastar capacidades públicas con los pilotos existentes sin asumir equivalencia ni reducir límites no confirmados.

### 3. Evaluar Mercado Pago

Identificar el reporte real, campos requeridos y proceso de navegación/descarga/importación. Probar repetición, superposición, identidad, correcciones, errores y conservación de versiones. Evaluar documentalmente la API oficial de reportes y comprobar acceso/paridad de cuenta cuando exista un token autorizado. Una API puede entregar CSV: el objetivo es reducir trabajo y fragilidad conservando el significado de los datos.

### 4. Medir vistas y filtros

Inventariar todas las entradas y priorizar órdenes, abastecimiento, compras, ingredientes/costos, inventario, ventas y resultados. Realizar cinco repeticiones por escenario medido, distinguir primera consulta y repetición, y no presentar percentiles sin muestra suficiente.

Comprobar mensajes iniciales, consultas por filtro, navegación durante cargas, respuestas atrasadas, doble acción, detalles y exportaciones. Separar tiempo del proveedor de trabajo local y espera por otras tareas. Registrar lo no medido explícitamente.

### 5. Revisar organización de UI

Evaluar seis tareas: entender variaciones, revisar costos, explicar inventario, preparar/modificar órdenes, comprobar fuentes e investigar diferencias. Proponer navegación por tarea, nombres, filtros, estados, tablas y foco. Entregar esquemas para revisión; no asumir mejoras de usabilidad humana sin observar al usuario.

### 6. Consolidar y priorizar

Separar defectos reproducidos, observaciones de código, riesgos, oportunidades y dependencias externas. Cada corrección propuesta incluye impacto, evidencia, alcance y prueba de aceptación. Mantener los controles existentes de publicación atómica, identidad, cobertura e históricos.

## Entregables disponibles

- [Informe ejecutivo y técnico](auditoria/2026-10-24/AUDITORIA_BREWIT.md).
- [Fuentes y conectores, con detalle de TotEat](auditoria/2026-10-24/FUENTES_Y_CONECTORES.md).
- [Hallazgos priorizados](auditoria/2026-10-24/HALLAZGOS_BREWIT.csv).
- [Matriz de cargas por pantalla](auditoria/2026-10-24/MATRIZ_CARGAS.csv).
- [Tiempos HTTP](auditoria/2026-10-24/TIEMPOS_API.csv), [tiempos UI](auditoria/2026-10-24/TIEMPOS_UI.csv) y [tiempos históricos](auditoria/2026-10-24/TIEMPOS_HISTORICOS.csv).
- [Cobertura de fuentes](auditoria/2026-10-24/COBERTURA_FUENTES.csv) y [evidencia agregada](auditoria/2026-10-24/EVIDENCIA_AGREGADA.json).
- [Propuesta de navegación y UX](auditoria/2026-10-24/PROPUESTA_UI.md) y [esquema navegable](auditoria/2026-10-24/PROPUESTA_UI.html).
- [Plan de correcciones](auditoria/2026-10-24/PLAN_CORRECCIONES.md).

Los scripts de reproducción se incluyen con los informes. Las capturas, transacciones, perfiles y manifiestos crudos permanecen fuera de Git en almacenamiento temporal privado. El [plan general recibido](master-data-files/Plan_auditoria_Brewit_Codex.md) se conserva sin cambios.
