const crypto = require('node:crypto');
const { VERSION, searchRecordedName, searchKey, literalGender } = require('./recorded-name-search');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function serviceMode(comments) {
  const text = searchKey(comments.join('\n'));
  const takeaway = /\b(?:llevar|lleavr|llvar|take\s*away)\b/u.test(text);
  const dineIn = /\b(?:servir|serivr|servr|local|aqui|aca)\b/u.test(text);
  const negated = /\b(?:no|ni)\b/u.test(text) && (takeaway || dineIn);
  return { key: !negated && takeaway !== dineIn ? takeaway ? 'takeaway' : 'dineIn' : 'unknown',
    ambiguous: negated || takeaway && dineIn, status: negated || takeaway && dineIn ? 'ambiguous' : takeaway || dineIn ? 'known' : 'missing' };
}
function analyzeOrderComments(order) {
  const comments = [...new Set((order.paymentComments || [order.paymentComment || '']).map(String))];
  const sourceValues = [...new Set(order.sourceGenderValues || [])].sort();
  const original = comments.filter(c => c.trim()).join('\n');
  const name = searchRecordedName(original), mode = serviceMode(comments);
  const literals = comments.map(literalGender);
  const values = new Set([...sourceValues, ...literals.map(g => g.value).filter(Boolean)]);
  const ambiguous = literals.some(g => g.status === 'ambiguous') || values.size > 1 || values.has('unknown');
  const gender = !ambiguous && values.size === 1 ? [...values][0] : null;
  const sourceHash = hash([order.orderKey, comments, sourceValues]);
  return { version: VERSION, sourceHash, original, comments, sourceEvidence: order.commentEvidence || [], name, mode, gender,
    genderStatus: ambiguous ? 'ambiguous' : gender ? 'known' : 'missing',
    genderOrigin: gender ? sourceValues.length ? 'source-field' : 'literal' : null,
    genderEvidence: literals.flatMap((g, i) => g.evidence.map(span => ({ ...span, commentIndex: i }))) };
}
module.exports = { VERSION, hash, serviceMode, analyzeOrderComments };
