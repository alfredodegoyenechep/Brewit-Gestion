(() => {
  const outputs = [...document.querySelectorAll('[data-toteat-masters-status]')];
  let publishedAt = null;
  const message = text => outputs.forEach(output => { output.textContent = text; });
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch('/api/integrations/toteat/masters/status', { cache: 'no-store' });
      if (!response.ok) throw Error('No se pudo consultar el estado de los maestros.');
      const { locations } = await response.json();
      for (const output of outputs) output.replaceChildren(...locations.map(s => {
        const p = document.createElement('p');
        p.textContent = `${s.name}: ${s.running ? 'Actualizando…' : s.lastError || (s.counts
          ? `${s.counts.products} productos · ${s.counts.ingredients} ingredientes · ${s.counts.extras} extras · ${s.counts.recipes} recetas (${s.counts.recipeLines} líneas) · ${s.counts.suppliers} proveedores · jerarquías ${Object.values(s.counts.hierarchies).join(' / ')} · leído ${new Date(s.observedAt).toLocaleString('es-CL')}${s.warnings.length ? ` · ${s.warnings.length} configuraciones de stock por revisar` : ''}`
          : 'Pendiente de lectura')}`;
        return p;
      }));
      const version = locations[0]?.publishedAt;
      if (version && publishedAt !== version) window.dispatchEvent(new Event('brewit-masters-updated'));
      publishedAt = version;
      document.querySelectorAll('[data-toteat-masters-sync]').forEach(button => { button.disabled = locations.some(s => s.running); });
    } catch (error) { message(error.message); }
    finally { polling = false; }
  }
  document.querySelectorAll('[data-toteat-masters-sync]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const location = 'store-1';
      const response = await fetch('/api/integrations/toteat/masters/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location }) });
      if (!response.ok) throw Error((await response.json()).error);
      await poll();
    } catch (error) { message(error.message); }
    finally { await poll(); }
  }));
  setInterval(poll, 10000); poll();
  fetch('/api/integrations/toteat/inventory/pilot', { cache: 'no-store' }).then(async response => {
    if (!response.ok) return;
    const s = await response.json(), output = document.querySelector('[data-toteat-inventory-pilot]');
    const p = document.createElement('p'), link = document.createElement('a');
    p.textContent = `Piloto 23–30 agosto: ${s.rows} registros · ${s.nativeReconciliationPassed ? 'movimientos conciliados con Toteat' : 'movimientos por revisar'}. ${s.countDifferences} diferencias de conteo físico; ${s.fileDifferences} diferencias frente a archivos anteriores y ${s.missingFileCells} celdas sin correspondencia. Recetas estimadas sobre ${s.recipeOrders} de ${s.recipeSourceOrders} órdenes. El piloto aún no reemplaza los archivos de inventario.`;
    link.href = s.exportUrl; link.textContent = 'Descargar comparación del piloto';
    output.replaceChildren(p, link);
  }).catch(() => {});
})();
