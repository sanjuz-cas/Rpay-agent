# Cakebot on Replit

## Run

The Replit workflow runs the app with:

```bash
PORT=5000 npm start
```

For local development, `npm start` uses port 3000 unless `PORT` is set.

## Modes

- Razorpay runs in mock mode until `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are configured with test-mode values.
- Gemini or Anthropic keys enable model parsing. Without them, complete requests with an explicit weight, flavor, and ISO date use the deterministic parser; incomplete requests escalate for review.
- The merchant wallet shown in the UI is an explicitly labelled in-memory demo balance. Production wallet funding and persistence still need a durable store and Razorpay funding flow.