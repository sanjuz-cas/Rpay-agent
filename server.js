require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const path = require('path');

const { orders, auditLog, bookedDates, wallet, logAudit } = require('./store');
const { decideOnOrder } = require('./agent');
const { createCustomerPaymentLink, chargePerRunFee, hasKeys } = require('./razorpay');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/design-preview', async (req, res) => {
  const design = String(req.body?.design || '').trim();
  const flavor = String(req.body?.flavor || 'celebration cake').trim();
  if (!design) return res.status(400).json({ error: 'design description is required' });
  if (!process.env.HF_TOKEN) return res.status(503).json({ error: 'HF_TOKEN is not configured. Add it to .env to generate previews.' });
  const prompt = `Professional bakery product photo of a ${flavor} cake. Design: ${design}. Elegant, realistic, appetizing, clean studio lighting, centered composition, premium bakery catalog photography, no people, no brand logos, no watermark.`;
  logAudit({ action: 'TOOL_CALL', tool: 'generate_cake_design', reasoning: `Generating a visual cake preview from the customer design request.` });
  try {
    const response = await fetch(`https://router.huggingface.co/hf-inference/models/${process.env.IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell'}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt }) });
    if (!response.ok) throw new Error(`Hugging Face error (${response.status}): ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/png';
    logAudit({ action: 'DESIGN_PREVIEW_GENERATED', tool: 'generate_cake_design', reasoning: 'Cake preview generated successfully.' });
    res.json({ image: `data:${contentType};base64,${buffer.toString('base64')}`, provider: 'Hugging Face', model: process.env.IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell' });
  } catch (err) {
    logAudit({ action: 'DESIGN_PREVIEW_FAILED', tool: 'generate_cake_design', reasoning: err.message });
    res.status(502).json({ error: err.message });
  }
});

const PER_RUN_FEE = 5; // ₹5 charged to the baker per successfully completed order — the subscription replacement

function walletSnapshot() {
  return { balance: wallet.balance, transactions: wallet.transactions.slice().reverse() };
}

function debitWallet(order) {
  if (wallet.debitedOrders.has(order.id)) return false;
  if (wallet.balance < PER_RUN_FEE) throw new Error('Insufficient agent wallet balance. Add funds before completing this order.');
  wallet.balance -= PER_RUN_FEE;
  wallet.debitedOrders.add(order.id);
  wallet.transactions.push({ id: `fee_${order.id}`, orderId: order.id, amount: -PER_RUN_FEE, type: 'debit', label: 'Cake order completed', meta: 'Agent fee recorded after successful payment', createdAt: new Date().toISOString() });
  return true;
}

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
    status: decision.decision === 'ESCALATE' ? 'escalated' : decision.decision === 'NEEDS_CUSTOMER_INPUT' ? 'waiting_customer' : 'quoted',
    createdAt: new Date().toISOString(),
  };
  orders.set(orderId, order);

  logAudit({
    orderId,
    action: decision.decision,
    reasoning: decision.reasoning,
    amount: decision.amount || null,
  });
  for (const event of decision.trace || []) logAudit({ orderId, ...event });

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
    logAudit({ orderId: order.id, action: 'TOOL_CALL', tool: 'create_razorpay_payment_link', reasoning: 'Creating a customer payment link after approval.' });
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
    logAudit({ orderId: order.id, action: 'TOOL_CALL', tool: 'verify_customer_payment', reasoning: 'Confirming payment before completing the order.' });
    const fee = await chargePerRunFee({ orderId: order.id, feeAmount: PER_RUN_FEE });
    debitWallet(order);
    order.perRunFeeCharged = PER_RUN_FEE;
    order.feeMode = fee.mock ? 'simulated' : 'order-created';
    orders.set(order.id, order);

    logAudit({
      orderId: order.id,
      action: 'PER_RUN_FEE_CHARGED',
      reasoning: `Agent completed the order-to-payment loop. Recorded a ₹${PER_RUN_FEE} usage fee in the merchant wallet.`,
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

// Customer clarification resumes the existing order instead of creating a duplicate.
app.post('/api/order/:id/customer-reply', async (req, res) => {
  const order = orders.get(req.params.id);
  const reply = String(req.body?.message || '').trim();
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status !== 'waiting_customer') return res.status(400).json({ error: 'This order is not waiting for customer information.' });
  if (!reply) return res.status(400).json({ error: 'customer reply is required' });

  const combinedMessage = `${order.message}. Customer clarification: ${reply}`;
  try {
    const decision = await decideOnOrder(combinedMessage);
    order.message = combinedMessage;
    Object.assign(order, decision);
    order.status = decision.decision === 'ESCALATE' ? 'escalated' : decision.decision === 'NEEDS_CUSTOMER_INPUT' ? 'waiting_customer' : 'quoted';
    orders.set(order.id, order);
    logAudit({ orderId: order.id, action: 'CUSTOMER_REPLY_RECEIVED', audience: 'customer', reasoning: `Customer clarification received: ${reply}` });
    for (const event of decision.trace || []) logAudit({ orderId: order.id, ...event });
    if (decision.decision === 'AUTO_APPROVED') {
      const link = await createCustomerPaymentLink({ orderId: order.id, amount: order.amount, customerName: order.customerName, description: order.itemsSummary });
      order.paymentLink = link.short_url;
      order.status = 'awaiting_payment';
      orders.set(order.id, order);
      logAudit({ orderId: order.id, action: 'PAYMENT_LINK_CREATED_AUTONOMOUSLY', reasoning: 'Clarification completed the order requirements; payment link created within guardrails.', amount: order.amount });
    }
    res.json(order);
  } catch (err) {
    logAudit({ orderId: order.id, action: 'CUSTOMER_REPLY_FAILED', reasoning: err.message });
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/wallet', (req, res) => res.json(walletSnapshot()));

app.post('/api/wallet/top-up', (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: 'Top-up amount must be between ₹1 and ₹10,000.' });
  wallet.balance += Math.round(amount);
  wallet.transactions.push({ id: `topup_${nanoid(8)}`, amount: Math.round(amount), type: 'credit', label: 'Wallet top-up', meta: 'Demo top-up; connect Razorpay checkout for real funding', createdAt: new Date().toISOString() });
  logAudit({ action: 'WALLET_TOP_UP', reasoning: `Added ₹${Math.round(amount)} to the demo merchant wallet.` , amount: Math.round(amount) });
  res.json(walletSnapshot());
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
app.listen(PORT, '0.0.0.0', () => console.log(`Cakebot agent demo running on http://localhost:${PORT}`));
