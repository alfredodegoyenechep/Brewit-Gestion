// Offset-bearing payment exports describe instants. Compare them with Toteat's
// wall clock in Santiago, including Chile's daylight-saving changes.
const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function paymentLocalTimestamp(value) {
  const text = String(value || '').trim();
  if (!(value instanceof Date) && !/[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return null;
  const date = value instanceof Date ? value : new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(clock.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

module.exports = { paymentLocalTimestamp };
