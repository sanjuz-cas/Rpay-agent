require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const path = require('path');

const { orders, auditLog, bookedDates, logAudit } = require('./store');
const { decideOnOrder } = require('./agent');
const { createCustomerPaymentLink, chargePerRunFee, hasKeys } = require('./razorpay');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PER_RUN_FEE = 5; // ₹5 charged to the baker per successfully completed order — the subscription replacement

// 1. Customer sends a message -> agent parses it, quotes, checks availability
app.post('/api/order', async (req, res) => {
  const { customerName, message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const orderId = nanoid(8);

  let decision;
  try {
    decision = await decideOnOrder(message);
  } catch (err) {
    logAudit({ orderId, action: 'PARSE_FAILED', reasoning: err.message });
    return res.status(502).json({ error: `Agent parsing failed: ${err.message}` });
  }

  const order = {
    id: orderId,
    customerName: customerName || 'Anonymous customer',
    message,
    ...decision,
    status: decision.decision === 'ESCALATE' ? 'escalated' : 'quoted',
    createdAt: new Date().toISOString(),
  };
  orders.set(orderId, order);

  logAudit({
    orderId,
    action: decision.decision,
    reasoning: decision.reasoning,
    amount: decision.amount || null,
  });

  // The agent acts autonomously when the order is inside its safety bounds.
  if (decision.decision === 'AUTO_APPROVED') {
    try {
      const link = await createCustomerPaymentLink({
        orderId: order.id,
        amount: order.amount,
        customerName: order.customerName,
        description: order.itemsSummary,
      });
      order.paymentLink = link.short_url;
      order.status = 'awaiting_payment';
      orders.set(order.id, order);
      logAudit({ orderId, action: 'PAYMENT_LINK_CREATED_AUTONOMOUSLY', reasoning: 'Order was within the agent\'s confidence, availability, and amount limits. Payment link created without human approval.', amount: order.amount });
    } catch (err) {
      logAudit({ orderId, action: 'PAYMENT_LINK_FAILED', reasoning: err.message });
    }
  }

  res.json(order);
});

// 2. Baker (or auto-approval) confirms -> agent sends the customer a Razorpay payment link
app.post('/api/order/:id/send-payment-link', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status === 'escalated') {
    return res.status(400).json({ error: 'This order was escalated and needs manual resolution first.' });
  }

  try {
    const link = await createCustomerPaymentLink({
      orderId: order.id,
      amount: order.amount,
      customerName: order.customerName,
      description: order.itemsSummary || `${order.parsed?.weightKg}kg ${order.parsed?.flavor} cake`,
    });

    order.paymentLink = link.short_url;
    order.status = 'awaiting_payment';
    orders.set(order.id, order);

    logAudit({
      orderId: order.id,
      action: 'PAYMENT_LINK_SENT',
      reasoning: `Sent ₹${order.amount} payment link to customer.`,
      amount: order.amount,
    });

    res.json({ order, link });
  } catch (err) {
    logAudit({ orderId: order.id, action: 'PAYMENT_LINK_FAILED', reasoning: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order/:id/approve', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.decision !== 'PENDING_APPROVAL') return res.status(400).json({ error: 'This order does not require approval.' });
  order.status = 'quoted';
  order.approvedByBaker = true;
  orders.set(order.id, order);
  logAudit({ orderId: order.id, action: 'BAKER_APPROVED', reasoning: 'Baker approved the quote and allowed payment link creation.', amount: order.amount });
  res.json(order);
});

app.post('/api/order/:id/reject', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.decision !== 'PENDING_APPROVAL' || order.approvedByBaker) {
    return res.status(400).json({ error: 'This order is not waiting for baker approval.' });
  }

  order.status = 'rejected';
  order.rejectedByBaker = true;
  orders.set(order.id, order);
  logAudit({
    orderId: order.id,
    action: 'BAKER_REJECTED',
    reasoning: 'Baker rejected the quote. No payment link was created and no wallet fee was charged.',
    amount: order.amount,
  });
  res.json(order);
});

// 3. Customer pays -> order confirmed -> agent charges the BAKER the small per-run fee
//    (In production this route doubles as the Razorpay webhook target.)
async function markPaid(req, res) {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status === 'confirmed' && order.perRunFeeCharged) {
    return res.json({ order, alreadyProcessed: true });
  }
  if (order.status !== 'awaiting_payment' && order.status !== 'confirmed') {
    return res.status(400).json({ error: 'Order is not awaiting payment.' });
  }

  if (order.status === 'awaiting_payment') {
    order.status = 'confirmed';
    for (const item of order.parsed.items || []) bookedDates.add(item.date);
    orders.set(order.id, order);

    logAudit({
      orderId: order.id,
      action: 'CUSTOMER_PAYMENT_CONFIRMED',
      reasoning: `Customer paid ₹${order.amount}. Order confirmed: ${order.itemsSummary || order.parsed?.date || 'see items'}.`,
      amount: order.amount,
    });
  }

  try {
    const fee = await chargePerRunFee({ orderId: order.id, feeAmount: PER_RUN_FEE });
    order.perRunFeeCharged = PER_RUN_FEE;
    order.feeMode = fee.mock ? 'simulated' : 'order-created';
    orders.set(order.id, order);

    logAudit({
      orderId: order.id,
      action: 'PER_RUN_FEE_CHARGED',
      reasoning: `Agent completed the order-to-payment loop. Charged baker ₹${PER_RUN_FEE} instead of a monthly subscription.`,
      amount: PER_RUN_FEE,
    });

    res.json({ order, fee });
  } catch (err) {
    logAudit({ orderId: order.id, action: 'PER_RUN_FEE_FAILED', reasoning: err.message });
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/order/:id/mark-paid', markPaid);
app.get('/api/order/:id/mark-paid', markPaid);

app.get('/api/orders', (req, res) => {
  res.json([...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/api/audit', (req, res) => {
  res.json([...auditLog].reverse());
});

const { activeProvider } = require('./llmAgent');

app.get('/api/status', (req, res) => {
  res.json({
    razorpayMode: hasKeys ? 'live-test-mode' : 'mock',
    llmMode: activeProvider(),
    perRunFee: PER_RUN_FEE,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cakebot agent demo running on http://localhost:${PORT}`));
