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

## Transmission / fuel type dependency

**Requirement:** Only valid transmission/fuel combinations should be
selectable on a car — e.g. `Biodiesel` only makes sense for a `Manual`
car.

**Solution:** A picklist field dependency: `Car__c.Fuel_Type__c` is
controlled by `Car__c.Transmission_Type__c`.

| Transmission Type | Available Fuel Types |
|---|---|
| `Automatic` | Electric, Hybrid, Petrol, Diesel |
| `Manual` | Biodiesel, Gasoline, Petrol, Diesel |

Declarative field dependency, not a validation rule — invalid
combinations are unselectable rather than rejected after the fact.

## Car and Booking field history tracking

**Requirement:** Maintain an audit trail of changes to key financial and
operational fields — pricing and availability on the car, scheduling and
status on the booking.

**Solution:** Field History Tracking, enabled at the object level
(`enableHistory`) on both `Car__c` and `Booking__c`, with `trackHistory`
turned on for:

| Object | Fields tracked |
|---|---|
| `Car__c` | `Rental_Rate_Per_Day__c`, `Availability_Status__c` |
| `Booking__c` | `Start_Date_Time__c`, `End_Date_Time__c`, `Status__c`, `Payment_Status__c` |

## Validation rules

**Requirement:** Enforce data-integrity rules that a lookup filter or
field dependency can't express — cross-field status consistency, date
logic, and threshold-based limits — with a clear error message instead
of silent bad data.

**Solution:** Nine validation rules across three objects:

| Object | Rule | Blocks saving when |
|---|---|---|
| `Booking__c` | `Booking_Completion_Check` | Status = Completed and Payment Status ≠ Paid |
| `Booking__c` | `Check_Booking_and_Payment_Status` | Status = Confirmed and Payment Status = Pending |
| `Booking__c` | `Check_Mandatory_Cancellation_Reason` | Status = Cancelled and Cancellation Reason is blank |
| `Booking__c` | `Check_Future_Start_Date` | Start Date is in the past, on create or whenever it's changed |
| `Booking__c` | `Check_Booking_Dates` | Start Date is after End Date |
| `Booking__c` | `Check_Cancellation_After_Start` | Status is set to Cancelled and Start Date has already passed |
| `Review__c` | `Check_Review_Range` | Rating is outside 1–5 |
| `Coupon_Code__c` | `Check_Expiration_Date_for_Coupon` | Expiration Date is in the past, on create or whenever it's changed |
| `Coupon_Code__c` | `Check_Maximum_Discount_Limit` | Discount Percentage exceeds the `Max_Coupon_Code_Discount` threshold |

`Check_Future_Start_Date` and `Check_Expiration_Date_for_Coupon` both
fire on `ISCHANGED(...)` as well as `ISNEW()` — broader than their
stated requirements ("new bookings" / "new coupon codes"), which also
blocks editing an existing record's date into the past. Deliberate and
reasonable, just wider than the literal spec.

**Known bug:** `Check_Maximum_Discount_Limit`'s formula is
`Discount_Percentage__c > VALUE($CustomMetadata.System_Thresholds__mdt.Max_Coupon_Code_Discount.Value__c)/100`.
`Discount_Percentage__c` is a `Percent` field, so a 20% discount is
represented as `20`, not `0.20` — matching how the threshold itself is
stored (`Max_Coupon_Code_Discount.Value__c = 20`) and how it's used
correctly elsewhere (`Coupen_Discount__c` assigns the percent field
directly, no conversion). Dividing the threshold by `100` here turns 20
into 0.2, so the rule effectively blocks almost any discount ≥ 1%, not
just ones over the 20% limit. Should be
`Discount_Percentage__c > VALUE($CustomMetadata.System_Thresholds__mdt.Max_Coupon_Code_Discount.Value__c)`
with no division. Needs a fix in the org.

## Case categorization (support processes & record types)

**Requirement:** Support reps need to categorize a case into one of
three distinct issue types (Booking Inquiry, Maintenance Request,
Review Issue), each following its own status lifecycle, and each
prompting only the Type/Reason options relevant to that category.

**Solution:** Three Business Processes — `Booking Inquiry`,
`Maintenance Request`, `Review Issue` — all sharing the same status
lifecycle (`New` → `Working` → `Escalated` → `Closed`, `New` default),
paired with three matching Record Types that restrict Case's standard
`Type` and `Reason` picklists to a category-relevant subset:

| Record Type | Type options | Reason options |
|---|---|---|
| Booking Inquiry | Booking Problem, Payments, Questions, Other | Customer Error, System Issue, Other |
| Maintenance Request | Accident, Breakdown, Damage, Other | Mechanical Failure, Vehicle Condition, Other |
| Review Issue | Negative Review, Customer Feedback, Other | Service Failure, Policy Clarification, Other |

All three record types also restrict `Origin` to Email/Phone/Web and
`Priority` to Low/Medium/High (Medium default) — the same for every
category, not part of the categorization logic itself.

`Type` and `Reason` are standard Case picklists with no local
`valueSet` in their own field metadata — the per-category restriction
lives entirely in each Record Type's `picklistValues`, not on the field.

## Context-aware Case page layouts

**Requirement:** The case screen should surface only the fields
relevant to the case's category, so reps aren't scrolling past
irrelevant data.

**Solution:** One Page Layout per Case record type (paired with the
Business Processes/Record Types above), each surfacing different fields
first:

| Layout | Fields shown first |
|---|---|
| `Case-Booking Inquiry Layout` | Customer, Related Booking |
| `Case-Maintenance Request Layout` | Customer, Related Car |
| `Case-Review Issue Layout` | Customer, Related Booking, Review |

Matches the requirement exactly for all three.

## Car record page (360° view)

**Requirement:** One screen giving a complete operational view of a
car — details, upcoming and past bookings, related cases, photos,
activity, and audit info.

**Solution:** `Car_Record_Page`, a Lightning Record Page with: a Car
Details highlights section; two Booking related lists filtered on
`Status__c` (`Pending`/`Confirmed` = future, `Cancelled`/`Completed` =
past); a Related Cases list; a `Car_Images__r` gallery alongside the
`Car_Image__c` formula preview; an Activities panel; and both
`CreatedById`/`LastModifiedById` fields and the full field-history
related list for audit. All eight required sections are present.

A conditional formatting rule set (`Car_Rating_Ruleset`) is applied to
`Average_Rating__c`, driving the sad/smiling/happy icon-by-range
display. As with `CarOnRentalLogo` and `System_Thresholds__mdt`
earlier, only the *reference* to the rule set came through in
retrieval — its actual threshold/icon definition isn't in this repo,
so a fresh deploy of this page would need that rule set to already
exist in the target org.

## Booking record page (booking hub)

**Requirement:** One screen aggregating a booking's full lifecycle —
details, key car/customer info, payments, reviews, cases, activity, and
audit history.

**Solution:** `Booking_Record_Page`: Booking Details section; Key Car
Info; Key Customer Info (`Customer__r.Email`, `Customer__r.Phone`);
`Payment_Transactions__r`, `Reviews__r`, and `Cases__r` related lists;
an Activities panel; and both audit fields and the full field-history
related list.

**Gap:** Key Car Info only shows `Car__r.Name`, `Rental_Rate_Per_Day__c`,
and `Car_Family__c`. The requirement explicitly calls for transmission
type and fuel type too (`Car__r.Transmission_Type__c`,
`Car__r.Fuel_Type__c`), and neither is on the page. Worth adding next
time you're in App Builder.
