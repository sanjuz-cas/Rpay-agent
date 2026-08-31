# Cakebot Agent — pay-per-run micro-agents for small merchants

**Track:** AI Growth & Agentic Commerce (Razorpay AI Buildathon)

A working demo of an AI agent that runs a small merchant's order workflow
end-to-end and charges the merchant a small fee only for completed runs —
no monthly subscription. Built on Razorpay's Payment Links and Orders APIs.

This scopes down a broader idea (usage-based micro-payments for AI agent
skills, previously built as **Algogent**, an Algorand-based agent
marketplace that won First Prize at Uniq) into one concrete, working loop
on Razorpay's rails.

## The loop

1. A customer sends the baker's agent a message ("2kg chocolate cake for
   2026-09-20").
2. The agent parses the request, checks the baker's availability, and
   quotes a price.
3. **Gating on model confidence:** the parser (a real Gemini or Claude API
   call, see `lib/llmAgent.js`) is asked to self-report confidence on the
   extracted weight/flavor/date. Low-confidence parses are escalated to the
   baker rather than acted on — the agent doesn't guess when the model
   itself is unsure.
4. **Gating on amount:** quotes above ₹5,000 are held for the baker's
   approval instead of auto-sending a payment link.
5. **Escalation on conflict:** if the requested date conflicts with an
   existing booking, the agent escalates to the baker with a clear reason
   instead of auto-rescheduling. This is the failure case demoed live.
5. On approval, the agent creates a Razorpay Payment Link and sends it to
   the customer.
6. When the customer pays, the order is confirmed — **and the agent
   charges the baker a flat ₹5 completion fee via Razorpay**, instead of
   a monthly subscription. The baker only pays for work actually done.
7. Every step above is written to an audit trail (`/api/audit`) with a
   timestamp, the action taken, and the agent's stated reasoning — so
   every money-touching action is explainable after the fact.

## Why this fits the brief

- **Bounded and gated:** the approval threshold and availability check are
  hard limits the agent cannot bypass — visible in the code and in the UI.
- **Audit trail:** `/api/audit` is not a log dump; each entry is the
  agent's actual decision record.
- **One failure handled gracefully:** the double-booking case, demoed live
  rather than described.
- **Real differentiator:** the per-run fee (step 6) replaces a
  subscription model with pay-for-completed-work, which is the same
  mechanic proven in Algogent but applied to Razorpay's merchant rails.

## Running it

```bash
npm install
cp .env.example .env   # add Razorpay TEST MODE keys + a GEMINI_API_KEY (free)
npm start
```

Then open `http://localhost:3000`. Without a model key (Gemini or
Anthropic), order parsing falls back to regex and every order is escalated
(by design — see above). Without Razorpay keys, payments run in mock mode.
Add both to see the full live loop. Gemini is checked first since it has a
free tier with no credit card required — get a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

## What's simulated vs real

- **Real:** order intake runs on an actual Gemini or Claude API call (`llmAgent.js`)
  that extracts structured order data and self-reports confidence; Razorpay
  Payment Link creation; Razorpay Order creation for the per-run fee; the
  full decision/gating/escalation logic.
- **Simulated for the demo:** the UI can manually trigger customer payment;
  the same route also accepts Razorpay's payment-link callback. The ₹5
  merchant fee is simulated in mock mode; with Razorpay keys the demo creates
  a Razorpay Order, but production billing would require a mandate or saved
  payment method.
  Without `ANTHROPIC_API_KEY` set, order parsing falls back to a regex
  heuristic and is deliberately forced to low confidence, so it always
  escalates rather than silently running on a weaker parser.

## Architecture

```
customer message → agent.decideOnOrder()
                         ├─ ESCALATE (conflict) → human review, no charge
                         ├─ PENDING_APPROVAL (>₹5000) → baker confirms
                         └─ AUTO_APPROVED → Razorpay payment link sent
                                                  ↓ customer pays
                                          order confirmed
                                                  ↓
                                    Razorpay per-run fee charged to baker
                                                  ↓
                                          audit trail entry
```

## Next steps if this goes further

- Swap the regex parser for a real LLM call for order intake.
- Real Razorpay webhook verification (signature check) instead of the
  manual "mark paid" trigger.
- Generalize beyond cake orders to other single-operator services
  (tailoring, tutoring, home catering) using the same gated-agent pattern.
