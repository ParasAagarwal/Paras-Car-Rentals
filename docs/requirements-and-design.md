# Requirements & Design Decisions

This file tracks *why* a feature exists and *why it was built the way it
was* — the business requirement paired with the Salesforce mechanism
chosen to satisfy it. It complements the [Data Model](../README.md#data-model)
section of the README, which documents *what* exists (objects, fields,
relationships) but not the reasoning behind it.

Routine declarative setup (tabs, apps, page layouts, list views, data
loads) doesn't need an entry here — only things with actual business
logic or a non-obvious implementation choice behind them.

---

## Configurable business thresholds (`System_Thresholds__mdt`)

**Requirement:** Several business rules — discount limits, security
deposit percentage, cancellation deduction, minimum acceptable review
rating — need to be tunable by an admin without depending on a developer
to change code or hardcoded values.

**Solution:** A custom metadata type, `System_Thresholds__mdt`, with
`Threshold_Name__c`, `Value__c`, and `Description__c` fields. One record
per threshold, deployable/editable declaratively:

| Threshold Name | Value | Purpose |
|---|---|---|
| `Max_Auto_Approved_Discount` | 10 | Above this, a discount requires manual approval |
| `Max_Coupon_Code_Discount` | 20 | Ceiling on any coupon code's discount, to protect margin |
| `Security_Deposit_Percentage` | 20 | % of total price held as a refundable deposit |
| `Cancelled_Percentage` | 20 | % deducted from refund on booking cancellation |
| `Min_Review_Rating` | 3 | Below this, a review triggers follow-up action |

Custom metadata (not custom settings or hardcoded constants) was chosen
because its records are metadata, not data — they deploy with the org
and are visible/editable declaratively, matching the "no coder needed"
requirement.

## Booking payment roll-up summaries

**Requirement:** For a given booking, the system needs to know, at a
glance: how much has actually been paid, how much of that was the
security deposit, how much was later adjusted, and how much of the
deposit was refunded.

**Solution:** Four native Roll-Up Summary fields on `Booking__c`,
summing `Payment_Transaction__c.Amount__c` for transactions where
`Status__c = 'Success'`, filtered by `Type__c`:

| Field (Booking__c) | Payment_Transaction Type filter |
|---|---|
| `Total_Paid_Amount__c` | `Initial Payment` or `Partial Payment` |
| `Total_Security_Deposit_Paid__c` | `Security Deposit` |
| `Total_Adjustment__c` | `Adjustment` |
| `Total_Security_Refund_Amount__c` | `Refund` |

Native roll-ups (rather than a Flow/Apex-maintained field) were possible
here because `Payment_Transaction__c.Booking__c` is a Master-Detail
relationship — unlike the plain editable aggregate fields on `Car__c`
and `Contact` (`Total_Bookings_Value__c`, `Total_Lifetime_Spending__c`,
etc.), which sit behind Lookup relationships and so can't use native
roll-ups; those still need Flow/Apex to stay in sync.
