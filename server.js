require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const path = require('path');

const { orders, auditLog, bookedDates, wallet, logAudit } = require('./store');
const { decideOnOrder } = require('./agent');
const { createCustomerPaymentLink, chargePerRunFee, verifyWebhookSignature, hasKeys } = require('./razorpay');

const app = express();
app.use(cors());
app.use('/api/webhooks/razorpay', express.raw({ type: 'application/json' }));
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
    const imageModel = process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
    const response = await fetch(`https://router.huggingface.co/hf-inference/models/${imageModel}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt }) });
    if (!response.ok) throw new Error(`Hugging Face error (${response.status}): ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/png';
    logAudit({ action: 'DESIGN_PREVIEW_GENERATED', tool: 'generate_cake_design', reasoning: 'Cake preview generated successfully.' });
    res.json({ image: `data:${contentType};base64,${buffer.toString('base64')}`, provider: 'Hugging Face', model: imageModel });
  } catch (err) {
    logAudit({ action: 'DESIGN_PREVIEW_FAILED', tool: 'generate_cake_design', reasoning: err.message });
    res.status(502).json({ error: err.message });
  }
});

async function generateCakePreview(design, flavor = 'celebration cake') {
  const imageModel = process.env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  const prompt = `Professional bakery product photo of a ${flavor} cake. Design: ${design}. Elegant, realistic, appetizing, clean studio lighting, centered composition, premium bakery catalog photography, no people, no brand logos, no watermark.`;
  const response = await fetch(`https://router.huggingface.co/hf-inference/models/${imageModel}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt }) });
  if (!response.ok) throw new Error(`Hugging Face error (${response.status}): ${await response.text()}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { image: `data:${response.headers.get('content-type') || 'image/png'};base64,${buffer.toString('base64')}`, model: imageModel, prompt };
}

const BASE_RUN_FEE = 5;
const DESIGN_PREVIEW_FEE = 10;
const DESIGN_REVISION_FEE = 5;
const DEFAULT_IMAGE_MODEL = 'stabilityai/stable-diffusion-3-medium-diffusers';

function validateOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) return 'At least one and at most 20 cake items are required.';
  for (const item of items) {
    if (!Number.isFinite(item.weightKg) || item.weightKg <= 0 || item.weightKg > 100) return 'Each cake weight must be between 0 and 100kg.';
    if (!item.flavor || typeof item.flavor !== 'string') return 'Each cake must have a flavor.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || Number.isNaN(Date.parse(`${item.date}T00:00:00Z`))) return 'Each cake must have a valid delivery date.';
  }
  return null;
}

function walletSnapshot() {
  return { balance: wallet.balance, transactions: wallet.transactions.slice().reverse() };
}

function orderUsageFee(order) {
  return BASE_RUN_FEE + (order.designPreview?.status === 'approved' ? DESIGN_PREVIEW_FEE + Math.max(0, Number(order.designPreview.revisions || 0)) * DESIGN_REVISION_FEE : 0);
}

function debitWallet(order) {
  const feeAmount = orderUsageFee(order);
  if (wallet.debitedOrders.has(order.id)) return false;
  if (wallet.balance < feeAmount) throw new Error(`Insufficient agent wallet balance. Add ₹${feeAmount} before completing this order.`);
  wallet.balance -= feeAmount;
  wallet.debitedOrders.add(order.id);
  wallet.transactions.push({ id: `fee_${order.id}`, orderId: order.id, amount: -feeAmount, type: 'debit', label: 'Cake order completed', meta: `Agent fee: ₹${BASE_RUN_FEE} automation${order.designPreview?.status === 'approved' ? ` + ₹${DESIGN_PREVIEW_FEE} design preview` : ''}`, createdAt: new Date().toISOString() });
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

  if (decision.parsed?.confidence === 'high') {
    const validationError = validateOrderItems(decision.parsed.items);
    if (validationError) decision = { decision: 'ESCALATE', reasoning: `Order validation failed: ${validationError}`, parsed: decision.parsed, requiresHuman: true, trace: [{ action: 'HITL_REQUESTED', audience: 'baker', reasoning: validationError }] };
  }
  if (decision.decision === 'AUTO_APPROVED' && decision.parsed?.items?.some(item => item.design)) {
    decision = { ...decision, decision: 'DESIGN_REVIEW', reasoning: `${decision.reasoning} A custom design was requested, so a preview must be approved before payment.` };
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
    // Keep the customer-facing total explicit even when no design add-on is used.
    // This prevents completed orders from falling back to a misleading "Pending" label.
    customerTotal: Number.isFinite(decision.amount) ? decision.amount : null,
  });
  for (const event of decision.trace || []) logAudit({ orderId, ...event });

  // The agent acts autonomously when the order is inside its safety bounds.
  if (decision.decision === 'AUTO_APPROVED') {
    try {
      const link = await createCustomerPaymentLink({
        orderId: order.id,
        amount: order.customerTotal || order.amount,
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

app.post('/api/order/:id/design-preview', async (req, res) => {
  const order = orders.get(req.params.id);
  const design = String(req.body?.design || '').trim();
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (!design) return res.status(400).json({ error: 'design description is required' });
  if (!process.env.HF_TOKEN) return res.status(503).json({ error: 'HF_TOKEN is not configured.' });
  try {
    const preview = await generateCakePreview(design, order.parsed?.items?.[0]?.flavor || 'celebration cake');
    order.designPreview = { ...preview, design, status: 'generated', revisions: order.designPreview?.status ? Number(order.designPreview.revisions || 0) + 1 : 0, generatedAt: new Date().toISOString() };
    order.customerTotal = order.amount + DESIGN_PREVIEW_FEE;
    orders.set(order.id, order);
    logAudit({ orderId: order.id, action: 'DESIGN_PREVIEW_GENERATED', tool: 'generate_cake_design', reasoning: `Generated optional design preview. Customer add-on: ₹${DESIGN_PREVIEW_FEE}.`, amount: DESIGN_PREVIEW_FEE });
    res.json(order);
  } catch (err) { logAudit({ orderId: order.id, action: 'DESIGN_PREVIEW_FAILED', reasoning: err.message }); res.status(502).json({ error: err.message }); }
});

app.post('/api/order/:id/design-approve', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order?.designPreview?.image) return res.status(400).json({ error: 'Generate a design preview first.' });
  order.designPreview.status = 'approved';
  order.customerTotal = order.amount + DESIGN_PREVIEW_FEE;
  orders.set(order.id, order);
  logAudit({ orderId: order.id, action: 'DESIGN_APPROVED', reasoning: `Customer approved the design add-on. Customer total is ₹${order.customerTotal}.`, amount: DESIGN_PREVIEW_FEE });
  res.json(order);
});

app.post('/api/order/:id/design-reject', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order?.designPreview) return res.status(400).json({ error: 'No design preview exists.' });
  order.designPreview.status = 'rejected';
  order.customerTotal = order.amount;
  orders.set(order.id, order);
  logAudit({ orderId: order.id, action: 'DESIGN_REJECTED', reasoning: 'Design preview rejected; no design add-on was charged.' });
  res.json(order);
});

// 2. Baker (or auto-approval) confirms -> agent sends the customer a Razorpay payment link
app.post('/api/order/:id/send-payment-link', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status !== 'quoted') return res.status(409).json({ error: 'Order is not ready for payment.' });
  if (order.decision === 'PENDING_APPROVAL' && !order.approvedByBaker) return res.status(403).json({ error: 'Baker approval is required.' });

  try {
    logAudit({ orderId: order.id, action: 'TOOL_CALL', tool: 'create_razorpay_payment_link', reasoning: 'Creating a customer payment link after approval.' });
    const link = await createCustomerPaymentLink({
      orderId: order.id,
      amount: order.customerTotal || order.amount,
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
  if (order.decision !== 'PENDING_APPROVAL' || order.status !== 'quoted' || order.rejectedByBaker) return res.status(400).json({ error: 'This order does not require approval.' });
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
    const feeAmount = orderUsageFee(order);
    const fee = await chargePerRunFee({ orderId: order.id, feeAmount });
    debitWallet(order);
    order.perRunFeeCharged = feeAmount;
    order.feeMode = fee.mock ? 'simulated' : 'order-created';
    orders.set(order.id, order);

    logAudit({
      orderId: order.id,
      action: 'PER_RUN_FEE_CHARGED',
      reasoning: `Agent completed the order-to-payment loop. Recorded a ₹${feeAmount} usage fee in the merchant wallet.`,
    amount: orderUsageFee(order),
    });

    res.json({ order, fee });
  } catch (err) {
    logAudit({ orderId: order.id, action: 'PER_RUN_FEE_FAILED', reasoning: err.message });
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/order/:id/simulate-payment', markPaid);

app.post('/api/webhooks/razorpay', (req, res) => {
  if (!verifyWebhookSignature(req.body, req.get('x-razorpay-signature'))) return res.status(401).json({ error: 'Invalid Razorpay webhook signature.' });
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid webhook payload.' }); }
  if (event.event !== 'payment_link.paid') return res.json({ received: true, ignored: true });
  const orderId = event.payload?.payment_link?.entity?.reference_id;
  if (!orderId || !orders.has(orderId)) return res.status(404).json({ error: 'Referenced order not found.' });
  req.params.id = orderId;
  return markPaid(req, res);
});

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
    order.customerTotal = Number.isFinite(decision.amount) ? decision.amount : order.customerTotal;
    order.status = decision.decision === 'ESCALATE' ? 'escalated' : decision.decision === 'NEEDS_CUSTOMER_INPUT' ? 'waiting_customer' : 'quoted';
    orders.set(order.id, order);
    logAudit({ orderId: order.id, action: 'CUSTOMER_REPLY_RECEIVED', audience: 'customer', reasoning: `Customer clarification received: ${reply}` });
    for (const event of decision.trace || []) logAudit({ orderId: order.id, ...event });
    if (decision.decision === 'AUTO_APPROVED') {
      const link = await createCustomerPaymentLink({ orderId: order.id, amount: order.customerTotal || order.amount, customerName: order.customerName, description: order.itemsSummary });
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
    perRunFee: BASE_RUN_FEE,
    designPreviewFee: DESIGN_PREVIEW_FEE,
    designRevisionFee: DESIGN_REVISION_FEE,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Cakebot agent demo running on http://localhost:${PORT}`));
