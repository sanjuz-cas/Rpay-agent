// Simple in-memory store. Swap for a real DB later — kept dumb on purpose
// so the agent logic and audit trail stay the star of the demo.

const orders = new Map();
const auditLog = [];

// Simulates the baker's existing bookings, used to demonstrate the
// "agent detects a conflict and escalates instead of guessing" failure case.
const bookedDates = new Set(['2026-09-15']);

function logAudit(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  auditLog.push(record);
  console.log(`[AUDIT] ${record.action} — order ${record.orderId || '-'} — ${record.reasoning || ''}`);
  return record;
}

module.exports = { orders, auditLog, bookedDates, logAudit };
