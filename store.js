// Small file-backed store for the demo. It keeps the app restart-safe without
// adding a database dependency; production should replace this with a DB.
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'data', 'cakebot-state.json');

const orders = new Map();
const auditLog = [];
const wallet = {
  balance: 250,
  transactions: [{ id: 'initial', amount: 250, type: 'credit', label: 'Demo wallet provisioned', meta: 'Simulated starting balance', createdAt: new Date().toISOString() }],
  debitedOrders: new Set(),
};

// Simulates the baker's existing bookings, used to demonstrate the
// "agent detects a conflict and escalates instead of guessing" failure case.
const bookedDates = new Set(['2026-09-15']);

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const order of saved.orders || []) orders.set(order.id, order);
    auditLog.push(...(saved.auditLog || []));
    wallet.balance = Number(saved.wallet?.balance ?? wallet.balance);
    wallet.transactions = saved.wallet?.transactions || wallet.transactions;
    wallet.debitedOrders = new Set(saved.wallet?.debitedOrders || []);
    for (const date of saved.bookedDates || []) bookedDates.add(date);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[STORE] Could not load saved state: ${error.message}`);
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    orders: [...orders.values()], auditLog,
    wallet: { balance: wallet.balance, transactions: wallet.transactions, debitedOrders: [...wallet.debitedOrders] },
    bookedDates: [...bookedDates],
  }, null, 2));
}

loadState();

function logAudit(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  auditLog.push(record);
  saveState();
  console.log(`[AUDIT] ${record.action} — order ${record.orderId || '-'} — ${record.reasoning || ''}`);
  return record;
}

module.exports = { orders, auditLog, bookedDates, wallet, logAudit, saveState };
