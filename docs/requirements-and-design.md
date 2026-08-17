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

## Car service countdown

**Requirement:** Show how many days remain until a car's next scheduled
service, so overdue vehicles are obvious.

**Solution:** `Car__c.Service_Countdown__c`, a Number formula:
`Next_Service_Date__c - TODAY()`. Positive = days remaining, negative =
overdue — a plain date subtraction was enough, no automation needed.

## Dynamic car image display

**Requirement:** Show a car's photo where available, and a consistent
fallback where it isn't, rather than a broken image or blank space.

**Solution:** `Car__c.Car_Image__c`, a Text formula using `IMAGE()`:
returns `IMAGE(Primary_Image_Url__c, Name, 350, 400)` when
`Primary_Image_Url__c` is populated, otherwise falls back to the
`CarOnRentalLogo` static resource (the same asset used for the app's
brand logo). Because `Primary_Image_Url__c` points at an external image
host, that host also had to be added as a CSP Trusted Site
(`Car_Images_API`, `img-src` only) — without it Lightning blocks the
image request outright.

## Booking pricing chain

**Requirement:** Booking price, security deposit, applied discount, and
outstanding balance all need to be visible on the booking without manual
calculation, and the security deposit percentage must stay
admin-configurable.

**Solution:** A chain of formula fields on `Booking__c`, each building on
the last:

| Field | Formula | Notes |
|---|---|---|
| `Booking_Duration__c` | `End_Date_Time__c - Start_Date_Time__c` | Days, as a plain Number |
| `Base_Price__c` | `Car__r.Rental_Rate_Per_Day__c * Booking_Duration__c` | Cost before discounts/fees |
| `Security_Deposit__c` | `Final_Booking_Price__c * (VALUE($CustomMetadata.System_Thresholds__mdt.Security_Deposit_Percentage.Value__c) / 100)` | Reads the admin-configurable threshold — see above |
| `Booking_Balance__c` | `Final_Booking_Price__c - Total_Paid_Amount__c` | Outstanding amount, using the roll-up above |
| `Coupen_Discount__c` | `Coupon_Code__r.Discount_Percentage__c` | Surfaces the applied coupon's discount for visibility |

`Final_Booking_Price__c` itself is a plain editable Currency field
("based on applying discount and adjustment" per its description) —
it's set by automation, not a formula, since it needs to combine
`Base_Price__c` with discounts/adjustments that aren't pure formula
inputs.

## Cross-object lookup filters

**Requirement:** Several lookups need to be narrowed to only
relationally-valid records, so users can't manually link unrelated
records together (wrong customer's review, a car that's already
rented, a stale coupon).

**Solution:** Declarative lookup filters, no automation needed:

| Field | Filter | Prevents |
|---|---|---|
| `Booking__c.Car__c` | `Car__c.Availability_Status__c = 'Available'` | Double-booking a car that's rented or in maintenance |
| `Booking__c.Coupon_Code__c` | `Coupon_Code__c.Is_Active__c = true` | Applying an expired/inactive coupon |
| `Review__c.Booking__c` | Booking's `Customer__c` = the review's `Customer__c` | A customer reviewing someone else's booking |
| `Case.Review_ID__c` | Review's `Booking__c` = Case's `Related_Booking__c`, and Review's `Customer__c` = Case's `ContactId` | Linking a case to an unrelated review |

All are `isOptional = false` (hard filters) except `Booking__c.Car__c`,
which is `isOptional = true` — a warning the user can override, not a
hard block. That's inconsistent with the stated requirement ("must only
allow... currently available" cars) and the pattern used everywhere
else in this list; worth revisiting since a double-booking is the
costliest failure mode of the four.
