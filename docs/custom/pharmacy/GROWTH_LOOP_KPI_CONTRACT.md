# Pharmacy Growth Loop KPI contract

All calculations are restricted to one `line_account_id`. UTC instants are the
storage and comparison source; the Release 1 month selector renders and bounds
calendar months in Asia/Tokyo. `unknown` is a first-class value, never silently
zero. Rates show numerator, denominator, exclusions, and cohort maturity.

| Metric | Purpose | Numerator | Denominator / cohort | Observation window | Exclusions and unknown handling | Timestamp source | Interpretation | Retention contract |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| First-time follows | Size the new reachable cohort | distinct idempotent `first_follow` events | none; count metric | selected JST month | unblock/redelivery excluded; missing identity is not measurable | signed follow webhook event time | descriptive | growth events: proposed 180 days; production policy not yet approved |
| Measurable follows | Denominator for first intake | first-time follows whose 30-day window matured | first-time follow cohort | follow +30 days, observed through request time | immature rows shown separately | follow event plus dashboard observation time | descriptive | same as growth events |
| First submission rate | Measure movement to LINE intake | mature followed friends with an accepted first submission within 30 days | measurable follows | follow +30 days | drafts, uploads, cancelled-before-acceptance and unknown friend linkage excluded | first accepted submission event | temporal conversion, not causal | same as growth events |
| Second submission rate | Measure repeated pharmacy intake | patients with a second distinct accepted submission within 90 days | mature patient first-submission cohort | first accepted +90 days | family friend is not patient identity; unlinked identity is unknown; immature cohort separate | accepted submission events | descriptive recurrence | same as growth events |
| Primary source count | Show designated local-source volume | distinct accepted submissions classified `primary` | none; count metric | selected JST month | draft/revision duplicates and synthetic submissions excluded | first accepted event | descriptive | source assignment follows prescription operational retention |
| Other source count | Show broader-area volume | distinct accepted submissions classified `other` | none; count metric | selected JST month | same as primary | first accepted event | descriptive | same as source assignment |
| Unknown source / coverage | Expose attribution quality | unknown accepted submissions; coverage is primary+other | all accepted non-synthetic submissions | selected JST month | unknown remains visible and is never coerced to primary/other | first accepted event and latest source assignment | descriptive data-quality measure | same as source assignment |
| Other share | Compare attributed source mix | other | primary + other | selected JST month | unknown excluded from ratio and shown beside it; zero denominator yields null | first accepted event | descriptive | aggregate may follow growth-event retention |
| Promised count | Define the SLA denominator | ready submissions with an eligible quote | same value | ready events in selected JST month | no promise, cancelled, not-fulfillable, synthetic, or ready-after-range excluded | first ready event and quote `created_at` | descriptive | quote/event operational retention |
| On-time rate | Measure promise adherence | eligible rows where actual ready <= promised ready + configured grace | promised count | selected JST month | latest quote revision created before ready only; initial grace is explicit, never hidden | `estimated_ready_at`, quote creation, first ready event | descriptive SLA | quote/event operational retention |
| Late count / p50 / p90 | Show late-tail severity | late eligible rows; percentile over positive delay | promised count for late count; late rows for percentiles | selected JST month | average delay is secondary; no-promise shown separately | same SLA timestamps | descriptive SLA | quote/event operational retention |
| Promise revision count | Make promise changes auditable | eligible pre-ready quote revisions | promised submissions | selected JST month | post-ready quote excluded | quote revision creation time | descriptive | quote history retention |
| Verified validity | Show reviewed date coverage | validity rows in `verified` or later reviewed states | accepted submissions in scope | selected JST month | unknown/unverified dates remain separate | staff verification time | descriptive | validity operational retention |
| Reminder sent | Confirm reminder execution | rows with an idempotently recorded send | due verified validity rows | due time in selected JST month | closed/cancelled/not-ready/unknown dates excluded; failed sends not counted | `reminder_sent_at` | descriptive delivery | validity operational retention |
| Reminder then in-time close | Observe a useful sequence | reminded rows closed by `valid_until` | reminded validity rows | reminder through deadline | not called “prevented expiry”; missing close is unknown until window matures | reminder time, first closed event, valid date | estimated temporal association | validity/event retention |
| Expired review required / confirmed | Size pharmacist review work | rows in each fixed state | validity rows | selected JST month | no automatic close and no automatic “revisit required” conclusion | state update/audit time | descriptive | validity operational retention |
| Category sent count | Monitor communication load | successful sends per fixed category | none; count metric | selected JST month | failures and cap blocks excluded from sent; no message body retained | final notification event time | descriptive | notification events: proposed 180 days, pending approval |
| Proactive attempts / cap blocked | Verify frequency protection | all proactive outcomes / blocked proactive outcomes | proactive attempts | account-local JST month | care and manual categories excluded from cap; failed is not sent | notification event time | descriptive control metric | same as notification events |
| Unfollow within 24h / 72h | Detect possible adverse timing | exposed friends with a later unfollow in each window | distinct exposed friends with observable follow state | exposure +24h/+72h | no message-level causation; sample size always shown; small samples never auto-stop | successful exposure time and account-qualified unfollow webhook | estimated temporal association | raw exposure links proposed 30 days; aggregates 180 days; approval pending |

## Data contract

Metric events may contain only the account ID, opaque aggregate/subject key,
fixed event/category/outcome values, schema version, UTC timestamp, fixed
reason values, and an internal staff actor ID where audit requires it. They do
not copy message bodies, rendered notifications, LINE user IDs, patient names,
family relationships, medical institutions, prescription content, medication,
diagnosis, free text, or image/R2 references.

The proposed 180-day event and 30-day raw-exposure periods are a rollout Human
gate, not a claim that automated deletion already exists. Until the owner
approves and implements account-scoped audited retention, production rollout
must not present those periods as enforced.
