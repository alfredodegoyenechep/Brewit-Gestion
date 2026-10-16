const CURVES = [
  { id: '25-50-75', label: '25% → 50% → 75%', percentages: [25, 50, 75] },
  { id: '50-75', label: '50% → 75%', percentages: [50, 75] },
  { id: '33-66', label: '33% → 66%', percentages: [33, 66] }
];

// Count anniversaries from the original opening day, clamping short months.
function monthlyAnniversary(openingDate, months) {
  const date = new Date(`${openingDate}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function referenceStatus(rule = {}, openingDate, today) {
  const curve = CURVES.find(item => item.id === rule.curveId);
  const parsedOpening = new Date(`${openingDate}T00:00:00Z`);
  const validOpening = /^\d{4}-\d{2}-\d{2}$/.test(openingDate || '')
    && !Number.isNaN(parsedOpening.getTime()) && parsedOpening.toISOString().slice(0, 10) === openingDate;
  const endsAt = curve && validOpening ? monthlyAnniversary(openingDate, curve.percentages.length) : null;
  let stage = 0;
  if (endsAt && today >= openingDate) {
    while (stage < curve.percentages.length && today >= monthlyAnniversary(openingDate, stage + 1)) stage += 1;
  }
  const status = rule.enabled !== true ? 'disabled' : !endsAt ? 'unconfigured'
    : today < openingDate ? 'pending' : today >= endsAt ? 'expired' : 'active';
  return {
    enabled: rule.enabled === true,
    sourceLocationId: rule.sourceLocationId || '',
    curveId: curve?.id || CURVES[0].id,
    openingDate: validOpening ? openingDate : null,
    endsAt,
    status,
    active: status === 'active',
    percentage: status === 'active' ? curve.percentages[stage] : 0,
    month: status === 'active' ? stage + 1 : null
  };
}

function replenishmentConsumption(ownQuantity, ownDays, referenceDaily, percentage) {
  const ownAverageDailyConsumption = ownDays > 0 ? ownQuantity / ownDays : 0;
  const projectedAverageDailyConsumption = referenceDaily === null ? null : referenceDaily * percentage / 100;
  const averageDailyConsumption = Math.max(ownAverageDailyConsumption, projectedAverageDailyConsumption ?? 0);
  return {
    ownConsumption30: ownQuantity,
    ownAverageDailyConsumption,
    projectedAverageDailyConsumption,
    projectedConsumption30: projectedAverageDailyConsumption === null ? null : projectedAverageDailyConsumption * ownDays,
    usedConsumption30: averageDailyConsumption * ownDays,
    averageDailyConsumption
  };
}

module.exports = { CURVES, monthlyAnniversary, referenceStatus, replenishmentConsumption };
