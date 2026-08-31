const { bookedDates } = require('./store');
const { parseOrderWithLLM } = require('./llmAgent');

// --- Pricing table (₹ per kg by flavor) ---------------------------------
const PRICING = {
  chocolate: 900,
  vanilla: 750,
  'red velvet': 1100,
  fruit: 850,
  default: 800,
};

// Above this, the agent must not auto-send a payment link — it flags
// for the baker's approval instead. This is the "bounded and gated"
// requirement from the brief, made visible rather than just claimed.
const AUTO_APPROVE_LIMIT = 5000;

/**
 * Order intake now runs on a real model call (see lib/llmAgent.js), not
 * regex. The model is asked to self-report confidence — low-confidence
 * parses are escalated rather than acted on, which ties the "bounded and
 * gated" behavior to actual model uncertainty instead of a fixed rule.
 */
async function parseOrderMessage(message) {
  const result = await parseOrderWithLLM(message);
  return { ...result, raw: message };
}

function quotePrice(items) {
  return items.reduce((total, { weightKg, flavor }) => {
    const rate = PRICING[flavor] || PRICING.default;
    return total + Math.round(rate * weightKg);
  }, 0);
}

function checkAvailability(items) {
  for (const { date, flavor, weightKg } of items) {
    if (!date) return { available: false, reason: `No delivery date could be parsed for the ${weightKg}kg ${flavor} cake.` };
    if (bookedDates.has(date)) {
      return { available: false, reason: `Baker already has a confirmed order on ${date}.` };
    }
  }
  return { available: true };
}

/**
 * The core decision function. Returns a structured decision object that
 * both drives the API response AND becomes the audit trail entry —
 * so "explainable" isn't just a claim, it's the actual data shape.
 */
async function decideOnOrder(message) {
  const parsed = await parseOrderMessage(message);
  const items = parsed.items || [];

  if (parsed.confidence === 'low') {
    return {
      decision: 'ESCALATE',
      reasoning: `Low-confidence parse: ${parsed.reasoning}`,
      parsed,
      requiresHuman: true,
    };
  }

  const availability = checkAvailability(items);

  if (!availability.available) {
    return {
      decision: 'ESCALATE',
      reasoning: availability.reason,
      parsed,
      requiresHuman: true,
    };
  }

  const amount = quotePrice(items);
  const requiresApproval = amount > AUTO_APPROVE_LIMIT;

  // Human-readable summary: "1.5kg chocolate (2026-09-20) + 2.25kg red velvet (2026-09-25)"
  const itemsSummary = items
    .map(({ weightKg, flavor, date }) => `${weightKg}kg ${flavor}${date ? ` (${date})` : ''}`)
    .join(' + ');

  return {
    decision: requiresApproval ? 'PENDING_APPROVAL' : 'AUTO_APPROVED',
    reasoning: requiresApproval
      ? `Quote ₹${amount} for ${itemsSummary} exceeds the ₹${AUTO_APPROVE_LIMIT} auto-approve limit — baker must confirm.`
      : `Quote ₹${amount} for ${itemsSummary}, within auto-approve bounds.`,
    parsed,
    amount,
    itemsSummary,
    requiresHuman: requiresApproval,
  };
}

module.exports = { parseOrderMessage, quotePrice, checkAvailability, decideOnOrder, AUTO_APPROVE_LIMIT };
