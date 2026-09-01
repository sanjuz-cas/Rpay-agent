const Razorpay = require('razorpay');
const crypto = require('crypto');

const hasKeys = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET;

const instance = hasKeys
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

if (!hasKeys) {
  console.warn(
    '[razorpay] No RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET found in .env — running in MOCK MODE.\n' +
    '           The full flow still works, but no real Razorpay API calls are made.\n' +
    '           Add test-mode keys from the Razorpay dashboard to go live.'
  );
}

/**
 * Creates a payment link for the CUSTOMER to pay the baker for the cake.
 * This is the "makes the merchant transactable" half of the demo.
 */
async function createCustomerPaymentLink({ orderId, amount, customerName, description }) {
  if (!hasKeys) {
    return {
      id: `mock_link_${orderId}`,
      short_url: `https://rzp.io/mock/${orderId}`,
      amount,
      status: 'created',
      mock: true,
    };
  }
  return instance.paymentLink.create({
    amount: amount * 100, // paise
    currency: 'INR',
    description,
    customer: { name: customerName },
    notify: { sms: false, email: false },
    reference_id: orderId,
    callback_url: `${process.env.BASE_URL || 'http://localhost:3000'}/api/order/${orderId}/mark-paid`,
    callback_method: 'get',
  });
}

/**
 * Charges the BAKER a small per-completed-run fee once the loop closes
 * successfully — this is the subscription-replacement mechanic. In test
 * mode we simulate this as an Order (in production you'd charge a saved
 * payment method / mandate on the merchant's account).
 */
async function chargePerRunFee({ orderId, feeAmount = 5 }) {
  if (!hasKeys) {
    return {
      id: `mock_fee_${orderId}`,
      amount: feeAmount * 100,
      status: 'paid',
      mock: true,
    };
  }
  return instance.orders.create({
    amount: feeAmount * 100,
    currency: 'INR',
    receipt: `per-run-fee-${orderId}`,
    notes: { purpose: 'agent-run-completion-fee', orderId },
  });
}

function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

module.exports = { createCustomerPaymentLink, chargePerRunFee, verifyWebhookSignature, hasKeys };
