# Requirements & Design

This file records *why* each non-trivial feature of Car Rentals exists
and *how* it's built — the business requirement paired with the
Salesforce mechanism chosen to satisfy it. It complements the
[Data Model](../README.md#data-model) section of the README, which
covers *what* exists (objects, fields, relationships) without the
reasoning behind it.

Routine declarative setup (tabs, list views, page layout cosmetics)
isn't covered here — only things with real business logic or a
deliberate design choice behind them.

---

## 1. Configurable business thresholds

A number of business rules — discount limits, security deposit
percentage, cancellation deduction, minimum review rating, log
retention — need to be tunable by an admin without a code change.

**`System_Thresholds__mdt`**, a custom metadata type with
`Threshold_Name__c`, `Value__c` (text, parsed by whatever consumes it),
and `Description__c`, holds one record per threshold:

| Threshold Name | Value | Purpose |
|---|---|---|
| `Max_Auto_Approved_Discount` | 10 | Above this, a coupon discount requires manual approval |
| `Max_Coupon_Code_Discount` | 20 | Ceiling on any coupon code's discount |
| `Security_Deposit_Percentage` | 20 | % of booking price held as a refundable deposit |
| `Cancelled_Percentage` | 20 | % deducted from the deposit refund on cancellation |
| `Min_Review_Rating` | 3 | Below this, a review is treated as low-rated |
| `Days_To_Keep_Logs` | 7 | Retention window for the log cleanup batch job |
| `Email_Reputation` | (API key) | Credential for the email validation integration |
| `Log_Clean_up_Notification` | (email address) | Recipient for the log cleanup batch's summary report |

Custom metadata was chosen over custom settings or hardcoded constants
because its records are metadata — they deploy with the org and are
editable declaratively, matching the "admin, not developer" ownership
these values need.

## 2. Car and booking business rules

**Transmission / fuel type dependency.** `Car__c.Fuel_Type__c` is a
picklist dependency controlled by `Car__c.Transmission_Type__c`:
`Automatic` offers Electric, Hybrid, Petrol, Diesel; `Manual` offers
Biodiesel, Gasoline, Petrol, Diesel. Declarative field dependency, so
invalid combinations are simply unselectable rather than rejected after
the fact.

**Car service countdown.** `Car__c.Service_Countdown__c`, a Number
formula (`Next_Service_Date__c - TODAY()`), gives days remaining
(positive) or overdue (negative) until the next scheduled service.

**Dynamic car image display.** `Car__c.Car_Image__c`, a Text formula
using `IMAGE()`, shows the car's photo from `Primary_Image_Url__c` when
one exists, and falls back to the `CarOnRentalLogo` static resource
otherwise. Because `Primary_Image_Url__c` can point at an external
image host, that host is registered as a CSP Trusted Site
(`Car_Images_API`) so Lightning allows the image request.

**Field history tracking.** Enabled at the object level on `Car__c` and
`Booking__c`, with tracking turned on for `Rental_Rate_Per_Day__c` and
`Availability_Status__c` (Car), and `Start_Date_Time__c`,
`End_Date_Time__c`, `Status__c`, `Payment_Status__c` (Booking) — an
audit trail for the fields that matter most operationally and
financially.

**Cross-object lookup filters** keep related records honest:

| Field | Filter |
|---|---|
| `Booking__c.Car__c` | Car's `Availability_Status__c` must be `Available` |
| `Booking__c.Coupon_Code__c` | Coupon's `Is_Active__c` must be true |
| `Review__c.Booking__c` | Booking's `Customer__c` must match the review's `Customer__c` |
| `Case.Review_ID__c` | Review's `Booking__c`/`Customer__c` must match the case's `Related_Booking__c`/`ContactId` |

**Validation rules** enforce the logic a lookup filter or field
dependency can't express:

| Object | Rule | Blocks saving when |
|---|---|---|
| `Booking__c` | `Booking_Completion_Check` | Status = Completed and Payment Status ≠ Paid |
| `Booking__c` | `Check_Booking_and_Payment_Status` | Status = Confirmed and Payment Status = Pending |
| `Booking__c` | `Check_Mandatory_Cancellation_Reason` | Status = Cancelled and Cancellation Reason is blank |
| `Booking__c` | `Check_Future_Start_Date` | Start Date is in the past, on create or change |
| `Booking__c` | `Check_Booking_Dates` | Start Date is after End Date |
| `Booking__c` | `Validation_for_Booking_Cancellation` | Status is set to Cancelled and the start date has already passed |
| `Booking__c` | `Prevent_Coupon_Code_Change_if_Not_Pendin` | Coupon Code is changed once Status is no longer Pending |
| `Review__c` | `Check_Review_Range` | Rating is outside 1–5 |
| `Coupon_Code__c` | `Check_Expiration_Date_for_Coupon` | Expiration Date is in the past, on create or change |
| `Coupon_Code__c` | `Check_Maximum_Discount_Limit` | Discount Percentage exceeds the `Max_Coupon_Code_Discount` threshold (checked on new records) |

## 3. Booking pricing and lifecycle

**Pricing chain** — a sequence of formula fields on `Booking__c`, each
building on the last:

| Field | Formula |
|---|---|
| `Booking_Duration__c` | `End_Date_Time__c - Start_Date_Time__c` (days) |
| `Base_Price__c` | `Car__r.Rental_Rate_Per_Day__c * Booking_Duration__c` |
| `Security_Deposit__c` | `Final_Booking_Price__c * (Security_Deposit_Percentage threshold / 100)` |
| `Booking_Balance__c` | `Final_Booking_Price__c - Total_Paid_Amount__c` |
| `Coupen_Discount__c` | `Coupon_Code__r.Discount_Percentage__c` |

`Final_Booking_Price__c` is a plain editable Currency field, populated
by automation (below) since it combines the base price with a coupon
discount — not a pure formula input.

**Payment roll-ups** — four native Roll-Up Summary fields on
`Booking__c`, summing `Payment_Transaction__c.Amount__c` where
`Status__c = 'Success'`:

| Field (Booking__c) | Payment Transaction Type |
|---|---|
| `Total_Paid_Amount__c` | Initial Payment or Partial Payment |
| `Total_Security_Deposit_Paid__c` | Security Deposit |
| `Total_Adjustment__c` | Adjustment |
| `Total_Security_Refund_Amount__c` | Refund |

Native roll-ups work here because `Payment_Transaction__c.Booking__c`
is a Master-Detail relationship.

**Status lifecycle.** `Booking__c.Status__c` runs through six stages:
`Pending` → `Confirmed` → `Started` → `Completed` → `Cancelled` →
`Closed`. A Path Assistant on `Booking_Record_Page` guides a user
through each stage with contextual fields and notes — e.g. `Confirmed`
surfaces payment status and both dates; `Cancelled` surfaces the
cancellation reason; `Closed` surfaces the deposit and audit fields.

**New booking automation**, split across two flows for the right
transaction shape:

- *Field Update* (before-save, on create): sets `Final_Booking_Price__c`
  and defaults `Status__c`/`Payment_Status__c` to `Pending` — a single
  fast field update rather than a separate DML.
- *After Save activity* (after-save, on create, plus a 24-hour scheduled
  path): emails the customer a booking confirmation with the car
  details and pricing, creates a follow-up task for the owning agent,
  and — on the 24-hour path, if no payment has been made and the
  booking is still Pending — auto-cancels it with a system-generated
  cancellation reason.

**Cancellation automation** (`Post Booking Cancellation Automation`,
after-save when `Status__c` changes to `Cancelled`): synchronously
creates a `Refund` payment transaction for the security deposit (minus
the `Cancelled_Percentage` threshold) if one was paid, and a separate
`Adjustment` transaction for the full rent amount if any was paid, then
sets `Payment_Status__c` to `Refunded`. Closing related open Cases and
completing related open Tasks runs on an `AsyncAfterCommit` scheduled
path, independent of the payment logic, so cleanup always happens
regardless of payment history.

**Payment transaction trigger** (`PaymentTransactionTrigger`, after
insert/delete, dispatched through the metadata-driven trigger
framework) recalculates `Payment_Status__c` — `Paid` once rental and
deposit payments meet what's owed, `Partially Paid` otherwise — and
advances `Status__c` from `Pending` to `Confirmed` the moment any
payment succeeds.

**Booking overlap validation** (`BookingTrigger`, before insert/update)
blocks creating or moving a booking into dates that overlap another
active booking (`Pending`, `Confirmed`, `Started`, or `Completed`) for
the same car, via a `Booking_Overlap_Message` custom label. Only
re-validates on update when the car or either date actually changed.

**Car revenue tracking** (`BookingTrigger`, after update): when a
booking's status changes to `Closed`, a Queueable job
(`QueuableTotalCarValue`) sums `Total_Paid_Amount__c` across all of that
car's closed bookings into `Car__c.Total_Bookings_Value__c` —
asynchronous since the number isn't needed in real time.

**Car average rating** (`ReviewTrigger`, after insert/update/delete):
averages `Rating__c` across all reviews for a car (traced through each
review's booking) and stores it, rounded to the nearest whole number,
in `Car__c.Average_Rating__c`.

**Primary image synchronization**: when a `Car_Image__c` is marked
primary, `Sync Primary Image` (after-save) demotes any other primary
image for the same car and copies the new image's URL onto
`Car__c.Primary_Image_Url__c`. `Prevent Deletion Of Primary Image`
(before-delete) blocks deleting an image flagged primary.

## 4. Coupon code lifecycle

**Duplicate prevention**: a Matching Rule
(`Match_Based_on_Code_and_Percent`) doing an exact match on `Code__c`
and `Discount_Percentage__c`, paired with a Duplicate Rule that blocks
insert/update on a match — a coupon is only a duplicate if both the
code and the discount match an existing one.

**Approval workflow** (`Approval_for_Coupon_Code`, a record-triggered
Flow paired with the `Coupon_Code_Discount_Level_Approval` Approval
Process): on create, or when Discount Percentage, Expiration Date, or
Max Uses changes, looks up `Max_Auto_Approved_Discount` from
`System_Thresholds__mdt`. At or below the threshold, the coupon is
auto-approved. Above it, the record is submitted to the approval
process (assigned to the `Coupon Code Approver` queue), which sets
`Approval_Status__c` to `Pending`/`Approved`/`Rejected` at each stage.
Faults from any step in the flow publish to the `Log__e` logging
pipeline described in section 6.

## 5. Case management

**Categorization.** Three Business Processes — `Booking Inquiry`,
`Maintenance Request`, `Review Issue` — share one status lifecycle
(`New` → `Working` → `Escalated` → `Closed`), paired with matching
Record Types that scope Case's `Type` and `Reason` picklists to
category-relevant options:

| Record Type | Type options | Reason options |
|---|---|---|
| Booking Inquiry | Booking Problem, Payments, Questions, Other | Customer Error, System Issue, Other |
| Maintenance Request | Accident, Breakdown, Damage, Other | Mechanical Failure, Vehicle Condition, Other |
| Review Issue | Negative Review, Customer Feedback, Other | Service Failure, Policy Clarification, Other |

Each Record Type has its own Page Layout surfacing the fields most
relevant to that category first — Customer/Booking for Booking Inquiry,
Customer/Car for Maintenance Request, Customer/Booking/Review for
Review Issue.

**Automated routing**: a Case Assignment Rule routes Maintenance
Request cases to the `Fleet Management Team` queue, and Booking
Inquiry/Review Issue cases to the `Customer Support Queue`, emailing
the destination team via a Lightning email template.

**Automatic escalation**: an Escalation Rule reassigns a `Breakdown`
type case that's still `New` after 120 minutes to the
`Manager Escalation Queue` (whose member is the `Supervisor` role),
using Salesforce's standard escalation notification template.

**Low-rating review alert** (`ReviewTrigger`, after insert/update, when
`Rating__c` drops below the `Min_Review_Rating` threshold): grants the
`Customer_Support` group Read access to the related booking, and opens
a `Review Issue`/`Negative Review`/`Medium` priority case linked to the
booking, car, and customer.

## 6. Security and sharing model

**Profile and permission set.** `Car Rental Representative` (cloned
from Standard User) is the baseline profile — scoped to the Car On
Rental app only, with Setup access removed. `Rental Manager
Permissions` is a permission set layered on top for the Manager role,
adding the access below rather than a second profile.

**Object permissions — Representative profile:**

| Object | Read | Create | Edit | Delete |
|---|---|---|---|---|
| Contact | Yes | Yes | Yes | |
| Case | Yes | Yes | Yes | |
| Car | Yes | | Yes | |
| Booking | Yes | Yes | Yes | |
| Payment Transaction | Yes | Yes | | |
| Car Image | Yes | Yes | Yes | Yes |
| LogEvent | Yes | Yes | | |
| Coupon Code | Yes | | Yes | |
| Review | Yes | Yes | Yes | |

**Additional, via Rental Manager Permissions:** Create on Car, Edit +
Delete on Payment Transaction, Delete on LogEvent, Create + Delete on
Coupon Code — giving managers vehicle-inventory and financial-correction
authority that representatives don't have.

**Field-level security**: the Representative profile has read access
revoked on `Car__c.Total_Booked_Value`; the manager permission set
restores full Read/Edit on all `Car__c` fields.

**Org-wide sharing defaults:**

| Object | Default access |
|---|---|
| Case, Booking | Private |
| Car | Public Read Only |
| Contact, Coupon Code, LogEvent, Review | Public Read/Write |
| Payment Transaction, Car Image | Controlled by Parent |

Hierarchy-based access is on throughout, so a role's managers
automatically see what their reports own.

**Role hierarchy**: `CEO` → `Supervisor` → `Representative Agent`. The
Rental Manager Permissions set is assigned at the Supervisor level,
which — combined with Private sharing plus hierarchy access — gives
supervisors automatic visibility into their reports' bookings and cases
without any manual sharing.

**Criteria-based sharing rules:**

| Object | Shares with | Access | Condition |
|---|---|---|---|
| `Car__c` | Fleet Management Team | Edit | Availability Status is Under Maintenance or Out of Service |
| `Booking__c` | Marketing Team | Read | Post Booking Completion Audit is checked |

## 7. Trigger handling and logging framework

The project's trigger and logging infrastructure is Salesforce's
open-source [**apex-recipes**](https://github.com/trailheadapps/apex-recipes)
package, adopted rather than built from scratch. `TriggerHandler`, the
base class every handler extends, traces back to Kevin O'Hara's
[`sfdc-trigger-framework`](https://github.com/kevinohara80/sfdc-trigger-framework),
which apex-recipes extends with metadata-driven dispatch.

**How it fits together:**

| Component | Role |
|---|---|
| `TriggerHandler` | Base class every handler extends; routes to `beforeInsert()`/`afterUpdate()`/etc., guards against recursive triggers, supports bypassing a handler by name |
| `MetadataTriggerHandler` + `MetadataTriggerService` | A single dispatcher per object, invoked from one `.trigger` file, that reads `Metadata_Driven_Trigger__mdt` to decide which handler classes run and in what order |
| `Metadata_Driven_Trigger__mdt` | One record per (object, handler class): which object, which class, execution order, enabled flag |
| `Disabled_For__mdt` | A per-user override that excludes one trigger handler for one email address, without a deployment |
| `Log`, `LogMessage`, `LogSeverity` | Logging API — `Log.get()` builds a message (auto-attaching Quiddity and Request ID) and buffers it |
| `Log__e` (Platform Event) | Published outside the current transaction's rollback boundary, so a log entry survives even if the transaction that created it fails |
| `LogTrigger` → `LogTriggerHandler` | Converts each published `Log__e` into a durable `LogEvent__c` record |
| `errorPanel` / `ldsUtils` (LWC) | Front-end counterpart — `reduceErrors()` normalizes LDS/Apex error shapes into plain strings; `errorPanel` renders them consistently |
| `TestHelper`, `TestDouble` | Testing utilities bundled with the framework — runtime type-name lookup and a fluent stub provider for isolating handler classes in unit tests |

Triggers currently dispatched through this framework: `BookingTrigger`,
`ReviewTrigger`, `PaymentTransactionTrigger`, `ContactTrigger`, and the
framework's own `LogTrigger`.

Every autolaunched Flow and Queueable in this project routes its own
failures to the same `Log__e` pipeline, so a failure anywhere in the
system surfaces in one place (`LogEvent__c`) regardless of whether it
originated in a trigger, a Flow, or a background job. The
`LogCleanupBatch` scheduled job (below) keeps that log table bounded.

## 8. Scheduled maintenance

**Log cleanup batch job** (`LogCleanupBatch`, scheduled daily via
`LogCleanupBatchSchedule`): deletes `LogEvent__c` records older than
the `Days_To_Keep_Logs` threshold, using `Database.delete(scope, false)`
so an individual record failure doesn't stop the run. Processed,
succeeded, and failed counts accumulate across chunks
(`Database.Stateful`) and are emailed as a summary report to the
address configured in `Log_Clean_up_Notification` when the job
finishes.

## 9. External integrations

**Contact email validation**: whenever a Contact is created or its
email changes, `ContactTrigger` enqueues a Queueable
(`queueableEmailValidation`) that calls an external email-reputation
API through a Named Credential / External Credential pair, granted to
users via the `Car On Rental` permission set. A Contact's
`Email_Verified__c` is set to true only when the API's response reports
`deliverable` status with `valid_email` detail.

**Customer-facing car availability API**
(`CarAvailabilityRestApiService`, `GET /v1/cars/available/*`): accepts
a mandatory date range and pickup location, with optional fuel type and
transmission filters, and returns each matching car's id, name, rental
rate, image URL, fuel type, family, transmission type, description, and
location as a JSON array — built for an external client to consume
directly.

## 10. Record pages and screen flows

**Car record page**: a 360-degree operational view — car details,
upcoming and past bookings (split by status), related cases, an image
gallery, activity timeline, and audit fields — with a conditional
formatting rule set (`Car_Rating_Ruleset`) showing a sad/neutral/happy
face icon on `Average_Rating__c` depending on its value.

**Booking record page**: a booking hub — booking details, key car and
customer info, related payment transactions, reviews, and cases,
activity timeline, and audit history — with the Booking Status path
assistant in the header.

**Booking cost estimator** (`Estimate_your_Booking`, a screen flow
launched from a quick action on the Car record page): shows read-only
car details, takes a mandatory date range and optional coupon code
(validated live against active coupons), and calculates booking days,
base price, net price after discount, and security deposit — without
creating a real booking record. The same flow is reused inside the Car
Hunt experience (section 11) as a quick-estimate modal.

**Car return checklist** (`Car_Return_Checklist`, a screen flow
launched from a quick action visible only on `Completed` bookings):
captures fuel level and any new damage; if damaged, requires notes and
photo evidence, sets the car to `Under Maintenance`, creates a
follow-up task for the booking owner, and opens a Maintenance Request
case. Either way, it settles the security deposit refund (full or a
percentage deduction), records the customer's star rating and comments,
and closes the booking. The star rating input
(`c/starRating`) wraps a community-published Aura component
(`StarRatingComponent`, from [unofficialsf.com](https://unofficialsf.com/from-yumi-add-a-star-rating-component-to-your-screens/))
via `lightning/platformResourceLoader`, since Screen Flow has no
built-in star-rating field.

**Reusable placeholder component** (`c/placeholder`): a shared
"empty state" element with a configurable message, used across the
app wherever a list or query has nothing to show.

**Car rating & review panel** (`c/carRatingReview`, backed by
`CarReviewController`): shows a car's average rating and total review
count, a per-star distribution bar chart, and the full list of reviews
with rating, comments, and date — added to the Car record page.

**Car image manager** (`c/carImageManager`, backed by
`carImageController`): displays a car's photos in a carousel, falling
back to the placeholder component when there are none. New uploads are
resized client-side to fit within 500×500 (aspect ratio preserved,
letterboxed on white) and re-encoded as compressed JPEG before being
sent to Apex, which creates the `ContentVersion` and links it to a new
`Car_Image__c`. An uploader can flag an image as primary at upload time.

## 11. Car Hunt — search and booking experience

A three-panel search page — filter, results grid, detail card — for
finding and booking a car, built on a custom three-column Aura page
template (`pageTemplate`, implementing `lightning:appHomeTemplate`) and
composed onto a new `Car Hunt` app page:

- **`carFilter`** (left panel): keyword search plus transmission,
  fuel type, seats, rental rate, minimum rating, date range, and pickup
  location filters, publishing the combined filter set over the
  `carFilter` Lightning Message Channel 350ms after the last change.
- **`carTileList`** (center panel, backed by `carTileListController`):
  subscribes to the filter channel and queries available cars matching
  the criteria, rendering each as a `carTile` in a responsive grid.
  Shows a guidance placeholder before a search has been run, and a
  "no results" placeholder when nothing matches.
- **`carTile`**: a reusable listing card showing the car's photo,
  price, rating, transmission, and fuel type, with Select, Estimate
  Booking, and Book Now actions.
- **`carCard`** (right panel): subscribes to the `carSelection` message
  channel and, once a car is selected, shows its full details by
  composing the existing `carImageManager` (gallery) and
  `carRatingReview` (rating/reviews) components, plus a Book Now action.
- **`bookCarModal`**: a modal collecting Customer, Coupon Code, and
  date range via `lightning-record-edit-form`, associating the new
  booking with the selected car and running it through all of the
  same automation and validation described in section 3, then
  navigating to the new booking record on success.
- **`estimateCarBooking`**: a modal embedding the existing
  `Estimate_your_Booking` flow for a quick, non-committal price check
  before booking.
