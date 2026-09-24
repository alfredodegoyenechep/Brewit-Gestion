// Explicit opt-in for local recovery and isolated fixture-based tests only.
const manualFields = new Set(['mercadopago', 'marketing', 'employees']);
function register(enabled, install) { if (enabled) install(); }
module.exports = { register, manualFields };
