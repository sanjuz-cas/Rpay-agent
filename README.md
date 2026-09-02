# Cakebot Agent

Cakebot is a guardrailed AI order agent for small bakeries. It turns a customer message into a priced cake order, checks availability, requests human approval when needed, creates a Razorpay Payment Link, and records an explainable audit trail.

**Razorpay AI Buildathon track:** AI Growth & Agentic Commerce

## Live demo

**Try Cakebot:** https://rpay-agent.up.railway.app/

Cakebot is a pay-per-use AI commerce microservice. The bakery pays only when the agent successfully completes an order-to-payment workflow. Failed, rejected, ambiguous, and escalated requests are not charged.

## Why this is a strong fit

- AI extracts multiple cake items and separates flavor from design.
- Deterministic policy code controls pricing, availability, and the ₹5,000 auto-approval limit.
- Ambiguous requests go back to the customer; conflicts and risky orders go to the baker.
- Razorpay Payment Links make the bakery transactable.
- `/api/audit` records model output, tool calls, policy decisions, approvals, failures, and payment events.
- The UI demonstrates normal, ambiguous, over-limit, and double-booked flows.
- Buildathon demo mode can automatically complete mock payments after a payment link is created, while human approval remains manual.
- Orders, audit events, wallet activity, and booked dates survive server restarts through a lightweight local state file.

## Buildathon demo flow

Use the live demo and try these scenarios:

1. **Autonomous order** — `2kg chocolate cake for 2026-09-20` demonstrates extraction, pricing, availability, auto-approval, Razorpay Payment Link creation, and mock completion.
2. **Customer clarification** — `I need a cake next week` demonstrates that the agent asks for missing details instead of guessing.
3. **Scheduling guardrail** — `2kg chocolate cake for 2026-09-15` demonstrates conflict detection and safe escalation.
4. **Human approval** — `6kg chocolate cake for 2026-09-20` demonstrates the ₹5,000 approval gate before payment-link creation.
5. **Explainability and billing** — review the workflow timeline, audit trail, and merchant wallet after completion.

The **Auto-complete mock payments** control is intended for the buildathon demonstration. Real Razorpay test-mode payments are confirmed through the signed webhook flow.

The LLM is used for extraction and explanation. It never directly decides whether money may move.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Add Razorpay test-mode keys and optionally `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`. With no keys, the app runs with clearly labelled mock payment behavior and a deterministic parser.

## Verify the project

```bash
npm test
npm run evaluate
```

The tests cover pricing, missing information, scheduling conflicts, approval gating, and autonomous approval. The evaluation runner executes the cases in `evaluation/cases.json` and reports accuracy plus per-decision results. These are deterministic smoke-test metrics, not a claim of production model accuracy.

## Payment honesty

Customer payment links are real Razorpay test-mode calls when configured. The UI's “simulate payment” control is demo-only; production confirmation comes from the signed `payment_link.paid` webhook.

The merchant usage fee is represented by the in-memory wallet in this submission. In Razorpay test mode, the app creates an Order for the fee but does not actually debit a saved merchant payment method. A production version would collect that fee through an authorised mandate, saved payment method, or an explicit merchant checkout. No live money is moved by this demo.

## Architecture

```text
customer message
      ↓
LLM/heuristic extraction → missing fields → customer clarification
      ↓
deterministic policy engine
  ├─ unavailable date → baker escalation
  ├─ quote > ₹5,000 → baker approval
  └─ guardrails pass → Razorpay Payment Link
                                  ↓
                         signed payment webhook
                                  ↓
                    confirm order + record demo fee
                                  ↓
                            audit trail
```

## Submission demo script

1. Submit `2kg chocolate cake for 2026-09-20`; show autonomous quote and payment link.
2. Submit `I need a cake next week`; show customer clarification.
3. Submit `2kg chocolate cake for 2026-09-15`; show baker escalation for the booked date.
4. Submit `6kg chocolate cake for 2026-09-20`; show the ₹5,000 approval gate.
5. Leave “Auto-complete mock payments” enabled, then open the audit trail and wallet ledger to show the completed loop.

## Razorpay integration

Cakebot uses Razorpay Payment Links for customer checkout and listens for the `payment_link.paid` webhook to complete the order. Configure the webhook endpoint as:

```text
https://rpay-agent.up.railway.app/api/webhooks/razorpay
```

The server verifies the Razorpay webhook signature before confirming payment. Never commit API keys or webhook secrets to the repository.

## Project structure

- `agent.js` — extraction orchestration, pricing, availability, and policy decisions.
- `llmAgent.js` — Gemini/Claude JSON extraction with safe fallback behavior.
- `razorpay.js` — Payment Link, test Order, and webhook signature helpers.
- `server.js` — API routes and in-memory demo state.
- `index.html` — merchant dashboard and workflow demo.
- `test/agent.test.js` — automated guardrail tests.
- `evaluation/cases.json` and `evaluation/run.js` — reproducible decision benchmark.
