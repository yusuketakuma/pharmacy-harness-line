# Pharmacy Growth Loop KPI Contract

All metrics are account-scoped, PHI-free operational metrics. Timestamps are
stored as UTC instants and rendered in the account's configured Asia/Tokyo
timezone. A missing value is `unknown`, not zero. The dashboard must show the
cohort maturity and denominator beside every rate.

| Metric | Numerator | Denominator/cohort | Window | Exclusions and notes |
| --- | --- | --- | --- | --- |
| first-time follows | distinct first follow records | measurable follow records | selected month | webhook-redelivery is idempotent |
| first submission rate | friends with first accepted submission | measurable first-time follows | follow + 30 days | immature cohorts shown separately |
| second submission rate | friends with a second accepted submission | mature first-submission cohort | first accepted + 90 days | family patients use patient identity when linked; otherwise unknown |
| primary source count | accepted submissions classified `primary` | accepted submissions | selected month | multiple primary sources allowed per account |
| other share | `other` accepted submissions | primary + other accepted submissions | selected month | unknown excluded and shown separately |
| on-time rate | eligible ready events at/before promise + grace | eligible promises | selected month | latest pre-ready quote revision only |
| p50/p90 lateness | lateness for late eligible promises | late eligible promises | selected month | seconds, never average-only |
| validity reminder sent | idempotently sent reminders | due verified validities | selected month | no PHI in event or message |
| reminder then in-time close | validities closed by deadline after reminder | reminded validities | selected month | correlation, not causal proof |
| proactive cap blocked | blocked proactive sends | attempted proactive sends | rolling month | care/manual categories excluded |
| unfollow within 24h/72h | unfollows after an exposure | exposed friends with observable follow state | selected window | label as estimated temporal association; not message causation |

Each metric event stores only: `line_account_id`, opaque aggregate/event ID,
category/classification, UTC timestamp, schema version, and fixed reason codes.
No message body, prescription content, institution, medication, diagnosis,
patient name, LINE user ID, or free text is copied into analytics.

Retention follows the account's approved operational retention policy; the
Release 1 default is 180 days for aggregate events and 30 days for raw exposure
links. Deletion must be account-scoped and audited.

## Causal language

The dashboard may describe counts, rates, and temporal association. It must not
claim that a reminder caused an in-time completion or that a particular message
caused an unfollow.
