const test = require('node:test');
const assert = require('node:assert/strict');
const { quotePrice, checkAvailability, decideOnOrder, AUTO_APPROVE_LIMIT } = require('../agent');

test('quotes multiple cake items deterministically', () => {
  assert.equal(quotePrice([
    { weightKg: 2, flavor: 'chocolate' },
    { weightKg: 1.5, flavor: 'vanilla' },
  ]), 2925);
});

test('blocks dates already booked', () => {
  assert.deepEqual(checkAvailability([{ weightKg: 1, flavor: 'chocolate', date: '2026-09-15' }]), {
    available: false,
    reason: 'Baker already has a confirmed order on 2026-09-15.',
  });
});

test('requires a customer clarification when required fields are missing', async () => {
  const result = await decideOnOrder('I need a birthday cake next week');
  assert.equal(result.decision, 'NEEDS_CUSTOMER_INPUT');
  assert.match(result.reasoning, /flavor|date|weight/i);
});

test('escalates a known scheduling conflict', async () => {
  const result = await decideOnOrder('2kg chocolate cake for 2026-09-15');
  assert.equal(result.decision, 'ESCALATE');
  assert.match(result.reasoning, /confirmed order|conflict/i);
});

test('holds quotes above the autonomous approval limit', async () => {
  const result = await decideOnOrder('6kg chocolate cake for 2026-09-20');
  assert.equal(result.amount, 5400);
  assert.equal(result.decision, 'PENDING_APPROVAL');
  assert.equal(result.requiresHuman, true);
  assert.equal(AUTO_APPROVE_LIMIT, 5000);
});

test('auto-approves a complete order within bounds', async () => {
  const result = await decideOnOrder('2kg chocolate cake for 2026-09-20');
  assert.equal(result.decision, 'AUTO_APPROVED');
  assert.equal(result.amount, 1800);
  assert.ok(result.trace.some(event => event.action === 'POLICY_DECISION'));
});
