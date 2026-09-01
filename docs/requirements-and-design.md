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

A conditional formatting rule set (`Car_Rating_Ruleset`, a
`UiFormatSpecificationSet`) is applied to `Average_Rating__c`, driving
an icon-by-range display: `0 ≤ x < 3` → sad face (red), `x = 3` → happy
face (blue, the "smiling" tier), `3 < x ≤ 5` → big grin face (green).
Matches the described tiers exactly.

`System_Thresholds__mdt` (the custom metadata *type* definition, as
opposed to its record values documented above) and this rule set were
initially retrieved by reference only, without their own definitions —
both have since been pulled in properly.

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
`Car__r.Fuel_Type__c`), and neither is on the page — still true as of
this retrieval; this page picked up an unrelated tweak (`Car__c` added,
`Payment_Status__c` reordered) but not this fix. Worth adding next time
you're in App Builder.

## Security & sharing model

**Requirement:** Enforce separation of duties between day-to-day
Representatives and their Managers — least-privilege by default, with
Managers getting broader access without needing records manually
shared with them.

**Solution:** A profile + permission set pair, layered with role
hierarchy and sharing rules. (Documented from the owner's description
and screenshots, not a field-by-field metadata read.)

**Profile & permission set.** `Car Rental Representative` (cloned from
Standard User) is the baseline profile, restricted to the Car On Rental
app only, with Setup/wrench-menu access removed and record type
assignment scoped to it. `Rental Manager Permissions` is a permission
set layered on top for users in the Manager role, granting the
additional access below rather than duplicating a whole second profile.

**Object-level permissions — Representative profile:**

| Object | Read | Create | Edit | Delete |
|---|---|---|---|---|
| Contact (Customer) | Yes | Yes | Yes | |
| Case | Yes | Yes | Yes | |
| Car | Yes | | Yes | |
| Booking | Yes | Yes | Yes | |
| Payment Transaction | Yes | Yes | | |
| Car Image | Yes | Yes | Yes | Yes |
| LogEvent | Yes | Yes | | |
| Coupon Code | Yes | | Yes | |
| Review | Yes | Yes | Yes | |

**Object-level permissions — additional, via Rental Manager Permissions:**

| Object | Read | Create | Edit | Delete |
|---|---|---|---|---|
| Car | | Yes | | |
| Payment Transaction | | | Yes | Yes |
| LogEvent | | | | Yes |
| Coupon Code | | Yes | | Yes |

So a Manager can create Cars (Reps can't), fully manage Payment
Transaction and LogEvent records including deletion, and fully manage
Coupon Codes — all restricted for Reps.

**Field-level security:** the Representative profile has read access
revoked on `Car__c.Total_Booked_Value` (the only field-level
restriction called out); the Rental Manager Permissions set grants Read
+ Edit on all `Car__c` fields, overriding that for Managers.

**Sharing model (org-wide defaults):**

| Object | Default access |
|---|---|
| Case | Private |
| Booking | Private |
| Car | Public Read Only |
| Contact | Public Read/Write |
| Coupon Code | Public Read/Write |
| LogEvent | Public Read/Write |
| Review | Public Read/Write |
| Payment Transaction, Car Image | Controlled By Parent (Booking, Car) |

Grant Access Using Hierarchies is on for all of these, so a role's
managers automatically see what their reports own.

**Role hierarchy:** `CEO` (top) → `Supervisor` → `Representative Agent`.
One user was assigned each of the Supervisor and Representative Agent
roles; Rental Manager Permissions was assigned to the Supervisor-role
user. Because Booking and Case are Private with hierarchy access on,
this alone gives Supervisors automatic view/edit access to their
reports' Bookings and Cases — no manual sharing needed.

**Criteria-based sharing rules:**

| Object | Rule | Shares with | Access | When |
|---|---|---|---|---|
| `Car__c` | `Share_Record_With_Fleet_Team` | Fleet Management Team (public group) | Edit | `Availability_Status__c` = Under Maintenance or Out of Service |
| `Booking__c` | `Share_Record_With_Marketing_Team` | Marketing Team (public group) | Read | `Post_Booking_Completion_Audit__c` = true |

Both match their stated requirements exactly — Fleet gets edit access
the moment a car needs service, Marketing gets read-only access only
after a booking is fully audited.

**Confirmed:** every object's `<sharingModel>` is now present in this
repo's metadata and matches the table above exactly (this was flagged
as an outstanding retrieval gap earlier — resolved by a later object
retrieve, not something separately called out at the time).

**Manifest note:** this retrieval left `manifest/package.xml` rewritten
down to just `Profile: Admin, Car Rental Representative` — it lost the
original wildcards (ApexClass, LWC, StaticResource, etc.) from before.
Likely a side effect of a scoped "retrieve source in manifest" action in
VS Code. Left as retrieved rather than reverted unilaterally — worth
deciding whether the manifest should go back to broad wildcards or stay
as an explicit, intentionally-scoped list going forward.

## Trigger handling & logging framework

**Source: not custom-built.** This is Salesforce's own open-source
[**apex-recipes**](https://github.com/trailheadapps/apex-recipes)
sample repo, installed as a package rather than written from scratch —
`TriggerHandler.cls`'s header credits Kevin O'Hara's original
[`sfdc-trigger-framework`](https://github.com/kevinohara80/sfdc-trigger-framework)
as its base, which apex-recipes then extends. Confirmed by field
manageability too: `Metadata_Driven_Trigger__mdt`'s fields are
`SubscriberControlled` — i.e. package-owned, not org-authored.

**The problem it solves.** Two recurring pain points in any
non-trivial Salesforce org:

1. **Trigger sprawl.** Salesforce best practice is one trigger per
   object, but business logic still needs to be split across multiple
   focused handler classes, run in a defined order, and be
   individually toggleable — without a redeploy every time you need to
   turn one off.
2. **Logging that survives failure.** A `System.debug` or a normal DML
   log record is useless for diagnosing a failed transaction — if the
   transaction rolls back, so does the log you tried to write inside
   it. You need a way to record *what happened* that isn't undone by
   the failure that made you want to log it in the first place.

**How it works, piece by piece:**

| Component | Role |
|---|---|
| `TriggerHandler` | Base class every handler extends. Routes to `beforeInsert()`/`afterUpdate()`/etc., guards against recursive-trigger infinite loops via a per-class loop counter, and supports bypassing a handler by name at runtime. |
| `MetadataTriggerHandler` + `MetadataTriggerService` | A single dispatcher, invoked from one `.trigger` per object, that queries `Metadata_Driven_Trigger__mdt` for which handler classes apply to that object, instantiates them in `Execution_Order__c` sequence, and runs them — so adding, removing, reordering, or disabling business logic for an object is a custom metadata edit, not an Apex deployment. |
| `Metadata_Driven_Trigger__mdt` | One record per (object, handler class) pair: `Object__c` (which SObject), `Class__c` (which handler), `Execution_Order__c` (run order), `Enabled__c` (on/off switch). |
| `Disabled_For__mdt` | Per-user kill switch: a record referencing a `Metadata_Driven_Trigger__mdt` plus a `User_Email__c`. `MetadataTriggerService` excludes that handler for that one user (matched against `UserInfo.getUsername()`) — e.g. muting a handler for an integration user or a specific tester without touching anyone else. |
| `Log`, `LogMessage`, `LogSeverity` | The logging API surface: `Log.get().<severity>(message)` builds a `LogMessage` (auto-attaching Quiddity and Request ID) and buffers it for publish. |
| `Log__e` (Platform Event) | Why this survives rollbacks: platform events are published outside the current transaction's rollback boundary, so even if the transaction that logged the error fails and rolls back, the `Log__e` it published is not undone. |
| `LogTrigger` → `LogTriggerHandler` | Listens for the platform event and, in `afterInsert`, converts each `Log__e` into a durable `LogEvent__c` record — the object this project already had (`docs` entry near the top of this file) for storing Flow/Apex error and warning messages. |
| `errorPanel` / `ldsUtils` (LWC) | The front-end half of the same philosophy: `ldsUtils.reduceErrors()` normalizes Lightning Data Service / Apex error shapes (which vary in structure) into a plain string array; `errorPanel` renders them consistently instead of every component inventing its own error UI. |
| `TestHelper`, `TestDouble` | Testing-quality-of-life utilities bundled with the framework: `TestHelper` gets a class's runtime type name (useful for dynamic instantiation tests); `TestDouble` is a fluent `StubProvider` for mocking dependencies in Apex unit tests, so handler classes can be tested in isolation. |

**Current wiring status — infrastructure, not yet load-bearing.** Only
the logging half is actually active: `LogTrigger` is live and feeds
`LogEvent__c`. No `Metadata_Driven_Trigger__mdt` records exist yet, so
`MetadataTriggerHandler` isn't dispatching to anything — none of this
project's own objects (`Booking__c`, `Car__c`, etc.) have a trigger
wired through it yet. It's installed and ready, not yet in the
critical path.

**Is it worth keeping?** Yes. It's a maintained, Salesforce-authored
reference implementation of two problems most orgs eventually solve
badly on their own (trigger ordering/recursion bugs, and logs that
vanish exactly when you need them — on the failure path). Adopting it
now, before there's a second trigger handler competing for the same
object, is cheaper than retrofitting it later. The one honest caveat:
at the current project size, the metadata-driven dispatch layer
(`MetadataTriggerHandler`/`Metadata_Driven_Trigger__mdt`) is more
machinery than is needed until a second business-object trigger
actually shows up — reasonable to have in place as scaffolding, but
there's no urgency to populate `Metadata_Driven_Trigger__mdt` records
until that happens.

## Automated case routing

**Requirement:** Route incoming cases to the right team automatically —
Maintenance Requests to Fleet Management, Booking Inquiries and Review
Issues to Customer Support — with no manual triage.

**Solution:** One active Case Assignment Rule (`Assignment Based On
Record Type`) with two entries, both matching on `Case.RecordTypeId`
and both sending the same Lightning email template
(`Case Assignment Email Template`) to notify the destination queue:

| Case record type | Routed to |
|---|---|
| Maintenance Request | `Fleet Management Team` queue |
| Booking Inquiry, Review Issue | `Customer Support Queue` |

Matches the requirement exactly. The org also ships a second, inactive
`Standard` assignment rule with `Account.SLA__c`/`BillingCountry`
criteria pointing at a scratch-org demo user — that's default sample
data the org came with, not something built for this project, and it's
correctly left inactive.

**Gap:** `Customer_Support_Queue`'s members are the roles
`CustomerSupportInternational`/`CustomerSupportNorthAmerica` — leftover
demo-org roles, not part of this project's actual role hierarchy
(`CEO`/`Supervisor`/`Representative Agent`). A `Customer_Support` public
group was created alongside this work but was never actually added as
the queue's member — right now nobody in the real org structure is a
member of the queue cases get routed to. `Fleet_Management_Team`
queue, by contrast, is wired correctly to the `Fleet_Management_Team`
public group used elsewhere for maintenance sharing.

**Not retrievable:** the org-wide "no-reply" email address isn't
Metadata-API-retrievable (there's no `OrgWideEmailAddress` source
type), so it's configured in the org only — expected, not a gap.

## Automatic case escalation

**Requirement:** A Case of Type "Vehicle Breakdown" not updated within
2 hours should auto-escalate to the Manager role.

**Solution:** Escalation rule `Paras Car on Rental Escalations`: fires
when `Case.Type = 'Breakdown'` (the actual picklist value; "Vehicle
Breakdown" was shorthand) and `Case.Status = 'New'`, reassigns to the
`Manager Escalation Queue` (whose only member is the `Supervisor` role)
at 120 minutes, using Salesforce's standard
`SupportEscalatedCaseNotification` template. The added `Status = 'New'`
condition narrows it to only escalate while still untouched — reasonable,
though not explicitly called for in the requirement. Note Salesforce
Escalation Rules always measure time-since-creation (`CaseCreation`),
not literally "time since last update" — there's no alternative
declarative option, so this is the closest available implementation of
the stated requirement, not a shortfall in the setup.

**Fixed:** `Paras Car on Rental Escalations` is now `active = true`.

**Worth double-checking:** the bundled demo `Standard` rule still reads
`active = true` in this same retrieved file too. Salesforce only
allows one active escalation rule per object at a time (confirmed —
activating one is supposed to deactivate any other), so both showing
`true` here shouldn't be possible if this file reflects current org
state. Worth confirming directly in Setup → Case Escalation Rules
which one Salesforce actually treats as active; if it still shows
`Standard` as active there, this file just hasn't been re-retrieved
since, and `Standard` needs explicitly deactivating.

## Coupon code duplicate prevention

**Requirement:** Block creating (or saving) a coupon code that matches
an existing one on both Coupon Code and Discount Percentage.

**Solution:** A Matching Rule (`Match_Based_on_Code_and_Percent`) doing
an exact match on `Code__c` AND `Discount_Percentage__c` (both required
non-blank), paired with a Duplicate Rule
(`Block Duplicate Coupon Code`) that blocks on both insert and update
when that matching rule fires. Matches the requirement exactly — both
fields must match, not either, and it's active.

## Coupon code approval workflow

**Requirement:** Auto-approve coupon codes within the discount
threshold; submit ones above it for approval; re-submit on changes to
discount, expiration, or max uses; show the approval status prominently.

**Solution:** `Approval_for_Coupon_Code`, a record-triggered Flow, paired
with the `Coupon_Code_Discount_Level_Approval` Approval Process:

1. **Trigger.** Runs after save on create *or* update, but only when it
   matters: `ISNEW() || ISCHANGED(Expiration_Date__c) ||
   ISCHANGED(Discount_Percentage__c) || ISCHANGED(Max_Uses__c)` — exactly
   the three re-submission triggers called out in the requirement, plus
   new records.
2. **Threshold check.** Looks up `Max_Auto_Approved_Discount` from
   `System_Thresholds__mdt` (the same admin-configurable threshold used
   elsewhere) and compares it to `Discount_Percentage__c`.
3. **Auto-approval path.** At or below threshold → `Approval_Status__c`
   set to `Approved` directly, no approval process involved.
4. **Submission path.** Above threshold → submits the record to the
   `Coupon_Code_Discount_Level_Approval` process by name. That process
   has one step, assigned to the `Coupon Code Approver` queue, and sets
   `Approval_Status__c` to `Pending`/`Approved`/`Rejected` at
   submission/final-approval/final-rejection respectively. Because the
   flow re-evaluates on every relevant change, a record that drops back
   under the threshold after editing will auto-approve again rather than
   staying stuck in a stale approval state — a detail the requirement
   didn't explicitly ask for but which falls naturally out of this design.

**Error handling — reusing the apex-recipes logging framework.** All
three points that can fail (the threshold lookup, the approval
submission, and the auto-approval field update) wire their
`faultConnector` to a single `Publish_the_Error` step, which creates a
`Log__e` platform event (`Quiddity__c = 'Flow'`, `Request_Id__c =
'Coupon Code Approval'`, `Severity__c = 'High'`, message =
`$Flow.FaultMessage`). This is the exact same durable, rollback-safe
logging pipeline documented earlier
(`Log__e` → `LogTrigger` → `LogTriggerHandler` → `LogEvent__c`) — rather
than a Flow-specific error handling mechanism, this flow plugs into the
project's one standard logging path, so a failure here shows up in the
same place as any other logged error.

**Critical bug — this feature can't currently work.**
`Check_Maximum_Discount_Limit` (the validation rule flagged earlier for
dividing the threshold by 100 against another percent field) was
updated to only fire `AND(ISNEW(), ...)` — a legitimate, necessary
change, since without it the rule would hard-block *any* update that
goes through this approval flow. **But the underlying `/100` bug itself
was not fixed.** The rule still reads
`Discount_Percentage__c > VALUE(...Max_Coupon_Code_Discount.Value__c)/100`,
so it still blocks nearly any discount ≥ 1% on *new* coupon codes — which
means a coupon code can't even be created in the first place for this
whole approval workflow to run against. This needs the same fix flagged
before (drop the `/100`) before this feature can be exercised at all.

**Worth confirming:** the approval step uses
`whenMultipleApprovers: FirstResponse` (first person in the
`Coupon Code Approver` queue to act decides it), while the requirement
says the record "will only be marked Approved... after all required
Approvers have approved it" — wording that suggests unanimous consent
from multiple approvers. First-response-from-a-queue is a common and
reasonable interpretation of "a designated set of Approvers," but worth
a quick gut-check that it's the intended behavior rather than a stricter
multi-approver requirement.

**Gaps:**
- **Status Visibility isn't implemented yet.** No Path Assistant and no
  `Coupon_Code__c` record page exist in this repo, so there's currently
  no banner showing the approval status on the record — only the
  underlying `Approval_Status__c` field and the values it's set to.
- **The three field-update actions the approval process references**
  (`Update_Approval_Status_to_Pending/Approved/Rejected`) are only
  referenced by name in `Coupon_Code_Discount_Level_Approval` — their
  actual `WorkflowFieldUpdate` definitions live under a `workflows`
  metadata folder that hasn't been retrieved. Same "referenced but not
  retrieved" pattern as `CarOnRentalLogo`, the utility bar, and
  `Car_Rating_Ruleset` earlier — except this one would actually break a
  fresh deploy of this repo, since the approval process depends on them
  existing.

## Booking cost estimator (screen flow)

**Requirement:** Let a user get an accurate, transparent cost estimate
for a car booking — car details, date inputs with validation, coupon
validation, and a full calculated summary — without creating a real
Booking record.

**Solution:** `Estimate_your_Booking`, a two-screen flow launched from a
quick action (`Car__c.Estimate_Your_Booking`) added to the Car record
page's action bar (and bumped `numVisibleActions` from 3 to 5 so it
shows as a button rather than being buried in the overflow menu).

**Screen 1 — inputs, auto-fetched car details read-only:**
Car Name, Fuel Type, Location, Rental Rate Per Day, and Transmission
Type are pulled from `Get_Car_Details` (looked up by the quick action's
`recordId`) and shown as read-only fields — all five called for in the
requirement. Alongside them: mandatory Start Date and End Date, and an
optional Coupon Code.

**Validations, both as in-screen field validation rules (immediate
feedback, no server round-trip):**
- Start Date: `{!Start_Date_Of_Booking} > today()` — strictly greater
  than, so today itself is correctly rejected, not just past dates.
- End Date: `{!End_Date_Of_Booking} >= {!Start_Date_Of_Booking}` —
  "on or after," exactly as specified.
- Coupon Code: handled as flow branching rather than a field validation
  rule, since it needs a database lookup. If entered,
  `Get_Coupon_Code` queries `Coupon_Code__c` filtered on both
  `Code__c` equals the input *and* `Is_Active__c = true` in one query —
  so a code that exists but is inactive is indistinguishable from one
  that doesn't exist at all, and both correctly produce "not
  found" → the error path. On no match, the flow loops back
  (`isGoTo`) to the input screen with an error message shown via a
  `visibilityRule` tied to an `isCounponCodeValid` flag, while
  explicitly preserving whatever dates were already entered
  (`iniStartDate`/`iniEndDate`) so the user doesn't have to retype them.

**Calculations**, run in one `Assignment` element as a deliberate
sequential chain — each formula reads the *previous* item's just-updated
variable, which Salesforce Flow evaluates correctly since assignment
items execute top-to-bottom within one element:

1. `BookingDays` = `IF(start == end, 1, end - start)` — guards the
   same-day edge case so a one-day booking doesn't compute as 0 days.
2. `BookingPrice` = `BookingDays * Rental_Rate_Per_Day__c`
3. `NetPrice` = `BookingPrice`, minus the coupon's
   `Discount_Percentage__c` applied as a percentage, if a code was
   entered — otherwise `BookingPrice` unchanged.
4. `SecurityDeposit` = the `Security_Deposit_Percentage` system
   threshold applied to `NetPrice` (i.e., the post-discount amount) —
   consistent with how `Booking__c.Security_Deposit__c` applies the same
   threshold to `Final_Booking_Price__c` elsewhere in this project.

**Screen 2 — summary:** a branded header (org name/address/phone, current
date, and the company logo) followed by every required line item — car
name, transmission, fuel type, location, both dates, days, discount,
booking price, security deposit, and net price — plus a closing
"Thank You" message. All items from the requirement's final-summary list
are present.

**Recurring gap:** the summary screen's logo image
(`flowruntime:image`, `imageName: CarOnRentalLogo`) is yet another
reference to the same static resource flagged missing from this repo
multiple times now (the app's brand logo, the `Car_Image__c` fallback
formula, and now here). Four references and counting — worth a
dedicated retrieve of just that one static resource rather than
continuing to hit it feature by feature.

**Minor notes, not bugs:**
- `frmNetPrice` decides whether to apply a discount by checking
  `ISBLANK(Enter_Coupon_Code)` rather than checking whether
  `Get_Coupon_Code` actually returned a record. It's correct today only
  because of how the decision branches are wired — every path that
  reaches the calculation step with a non-blank code has already been
  through the validity check. It would be more self-evidently correct
  (and less fragile against future changes to the flow) to check the
  looked-up record directly instead of relying on that implicit
  guarantee.
- On the summary screen, if no coupon was entered, the "Discount" line
  displays `Get_Coupon_Code.Discount_Percentage__c` directly — which
  renders blank rather than "0%," since that lookup never ran on that
  path. Cosmetic only.

## Booking status lifecycle & path assistant

**Requirement:** Define the full booking lifecycle as distinct status
stages, and guide users through them with a path on the record page.

**Solution:** `Booking__c.Status__c` now has all six stages, in order:
`Pending` (default) → `Confirmed` → `Started` → `Completed` →
`Cancelled` → `Closed`. A Path Assistant (`Booking Status`) was added
covering all six values with per-stage guidance text and relevant
fields to check at each step (e.g. `Confirmed` surfaces
`Payment_Status__c`/`Car__c`/both dates; `Cancelled` surfaces
`Cancellation_Reason__c` and notes bookings can't be cancelled once
started; `Closed` surfaces the deposit/audit fields and notes the
booking is now archived), and it's been added to
`Booking_Record_Page`'s header, right below the highlights panel.
Matches the requirement exactly — all six stages, in the stated order,
each with its own guided step.

One of the path's info notes ("Bookings without payment after 24 hours
may be auto-cancelled") describes behavior that doesn't exist yet in
this repo — no automation currently enforces a 24-hour payment window.
Worth treating as a stated future requirement rather than documentation
of something already built.

This retrieval also brought in the org-wide sharing model fix noted
above, plus routine noise on the Case object (standard
Product/SLAViolation/PotentialLiability picklist values on the three
Case record types, and auto-generated queue list views for
Customer Support, Fleet Management, Manager Escalation, and Coupon
Code Approver) — bundled metadata from a broader retrieve, not
authored for this project.

## Car return checklist (screen flow)

**Requirement:** A single guided screen for an agent to close out a
completed booking — capture vehicle condition, branch into damage
reporting with photo evidence and follow-up automation when needed,
settle the security deposit, and collect the customer's rating and
feedback.

**Star rating component — sourcing decision.** Screen Flow has no
built-in star-rating input. The stated reasoning for how this was
solved, in order of preference actually followed: check AppExchange
first, treat writing a custom LWC as the last resort, and only build
one if nothing suitable exists. That search led to
[unofficialsf.com's "Add a star rating component to your screens"](https://unofficialsf.com/from-yumi-add-a-star-rating-component-to-your-screens/),
an established community-published, free, unmanaged Aura component
(`StarRatingComponent`, backed by a `fivestar` static resource). It
implements the `lightning:availableForFlowScreens` interface, which is
exactly what makes it selectable as a screen flow field, and was
installed as-is (not rebuilt as an LWC) — a reasonable call: an Aura
component already solving this exact problem, publicly documented and
in evident community use, is far less risk than hand-rolling a new
input component for something as self-contained as a star widget.

The one bit of debt from this install: the `fivestar` static resource's
zip still contains macOS `__MACOSX/._*` metadata files
(`._rating.css`, `._rating.js`, `._stars.svg`) — harmless leftovers
from how the zip was packaged, but worth stripping out next time this
resource is touched. Also note its `AuraDefinitionBundle` is pinned to
API v55.0 against this project's v67.0 — expected and correct to leave
alone, since it's a third-party bundle, not something to "fix" the way
a first-party API-version mismatch would be.

**Launch condition.** The `Car Return Process` quick action on
`Booking__c` only appears when `Record.Status__c = 'Completed'` (a
dynamic action visibility rule on the highlights panel) — correctly
enforcing "for a completed booking" declaratively, without needing
flow-side logic for it.

**The flow, screen by screen:**

1. **Vehicle condition.** Fuel Level (a dynamic choice set sourced
   directly from `Car__c.Fuel_Level__c`'s own picklist, so it can never
   drift out of sync with the field) and a required "Is any damage on
   Car?" checkbox.
2. **Damage details** — a whole section gated behind
   `Is_any_damage_on_Car = true` via `visibilityRule`: damage notes
   (required only when damage is checked — its validation formula
   `Is_any_damage_on_Car && LEN(notes) != 0` is redundant given the
   section's own visibility rule already guarantees the left side is
   true whenever it's evaluated, but not wrong) and a required file
   upload, matching "one or more images... as evidence."
3. **Refund details.** "Refund full security deposit?" (defaults true)
   or a percentage deduction, validated to be > 0 when a partial refund
   is chosen. The requirement says "a specific amount *or* percentage,"
   but the implementation only supports percentage (the field's help
   text says so explicitly) — a reasonable simplification, though it
   does narrow the stated option set to one of the two.
4. **Customer feedback.** The star rating component, and comments that
   are required only when the rating is below 3 —
   `OR(rating >= 3, NOT(ISBLANK(comments)))` — matching "less than 3"
   exactly, including the boundary (a rating of exactly 3 does not
   require comments).

**What happens on submit** (all in one sequence, each DML step's
`faultConnector` routing to an in-flow `Error_Screen` that shows
`$Flow.FaultMessage` directly to the agent — the right choice here,
since a live user is watching this screen flow in real time, unlike the
two autolaunched flows documented earlier that correctly publish to the
`Log__e` pipeline instead, since nobody's watching those):

- If damaged: `Availability_Status__c` → `Under Maintenance`,
  `Damage_Notes__c` set, uploaded images linked via
  `ContentDocumentLink`, a `High`-priority Task created for the booking
  owner (due tomorrow) to reassign affected future bookings, and a
  `Case` created with Record Type `Maintenance Request`, `Type =
  'Damage'`, `Status = 'New'`, linked to both the Car and the Customer.
  Both the Task subject and the Case subject/description text exactly
  match the requirement's specified wording and business logic.
- Either way: the Car record is updated (fuel level always; damage
  fields only if damaged), a `Payment_Transaction__c` of `Type =
  'Refund'` is created for the calculated deposit amount (feeding
  directly into `Total_Security_Refund_Amount__c` documented earlier), a
  `Review__c` is created from the rating/comments, and the `Booking__c`
  is updated to `Status = 'Closed'` with
  `Post_Booking_Completion_Audit__c = true` and
  `Security_Refund_Completed__c = true`.

That last update is a nice piece of unplanned integration: setting
`Post_Booking_Completion_Audit__c = true` here is exactly the trigger
condition for the Marketing Team sharing rule documented earlier, so
completing a return automatically makes the booking visible to
Marketing — and `Status = 'Closed'` lines up precisely with what the
Booking Status path assistant describes for that stage.

**Bugs found:**

- **The Task and Case subject text templates both duplicate the car
  name.** `taskSubject` reads
  `...damaged car : {!Get_Booking_Record.Car__r.Name}{!Get_Booking_Record.Car__r.Name}`
  and `caseSubject` reads
  `Damage Reported for Car - {!Get_Booking_Record.Car__r.Name}{!Get_Booking_Record.Car__r.Name} on Booking...`
  — the same merge field is pasted twice back-to-back with no
  separator in both templates, so the actual rendered subject repeats
  the car's name immediately (e.g. "...damaged car :
  Toyota CamryToyota Camry"). Needs one of each duplicate removed.
- **A clean (non-damaged) return never restores the car to
  `Available`.** The no-damage branch only assigns `Fuel_Level__c` to
  `updateCarRecord` before the DML update — `Availability_Status__c` is
  never touched, so a car returned in good condition keeps whatever
  status it had during the rental (e.g. still not bookable) instead of
  becoming available again. The requirement only specified the status
  change for the damaged case, but leaving the happy path's status
  unchanged looks like an oversight rather than an intentional choice —
  worth confirming and very likely needs a fix.

**Worth a second look, not confirmed bugs:**

- `Get_Record_Type_For_Case` looks up the `Maintenance_Request` record
  type by `DeveloperName` alone, with no `SobjectType = 'Case'` filter.
  Safe today since that name is presumably unique org-wide, but fragile
  if any other object ever gets a record type with the same API name.
- Uploaded damage images are linked to the **Booking** record
  (`LinkedEntityId = recordId`), not the Car or the newly-created
  Maintenance Case. Worth confirming that's the intended home for
  "evidence," since the damage itself is being tracked on the Case.

## New booking creation automation

**Requirement:** On every new booking, calculate its final price,
freeze the coupon once it's past Pending, email the customer a
confirmation, and give the owning agent a follow-up task — and if
nothing happens for 24 hours, treat it as abandoned and auto-cancel it.

**`Prevent_Coupon_Code_Change_if_Not_Pendin`** (validation rule):
blocks changing `Coupon_Code__c` once `Status__c` isn't `Pending`.
Matches the requirement exactly.

**`Post Booking Automation - Field Update`** (before-save, on create):
sets `Final_Booking_Price__c` and defaults both `Status__c` and
`Payment_Status__c` to `Pending` on every new record — a fast,
single-transaction field update rather than a separate after-save DML,
which is the right call here.

**Bug — duplicated, out-of-sync price calculation.** Rather than
reading the already-existing `Base_Price__c` formula field, this flow
recomputes the same thing itself:
`Rental_Rate_Per_Day__c * (End_Date_Time__c - Start_Date_Time__c)`.
That's missing the same-day guard that `Booking_Duration__c` (which
`Base_Price__c` is built on) has —
`IF(start == end, 1, end - start)`. For a same-day booking, this flow's
version computes 0 days and a $0 base/final price, while the
`Base_Price__c` field displayed elsewhere on the record would show one
full day's rate. Reading `{!$Record.Base_Price__c}` directly instead of
re-deriving it would have avoided both the duplication and the bug.

**`Post Booking Automation - After Save activity`** (after-save, on
create, plus a 24-hour scheduled path): sends the confirmation email
and creates the agent follow-up task. Both match the requirement almost
field-for-field — the email correctly pulls `Base_Price__c`,
`Final_Booking_Price__c`, and `Security_Deposit__c` (reusing the real
formula fields rather than recalculating), and the task's due date,
owner, and description text match exactly. One deviation, and it's the
right one: the requirement's task subject template includes
`{{Booking.CaseNumber}}`, a field that doesn't exist on `Booking__c` at
all (it's a Case-only field) — the implementation correctly dropped it
rather than trying to reference something invalid.

The 24-hour scheduled path re-queries the Booking fresh
(`Booking_Record_After_24_Hours`) rather than trusting the stale
`$Record` from creation time — the right pattern for a delayed path.
It auto-cancels when both `Total_Paid_Amount__c` and
`Total_Security_Deposit_Paid__c` are still zero.

**Bug — doesn't check the booking is still `Pending` before
auto-cancelling.** The 24-hour check only looks at the two payment
totals, never `Status__c`. If an agent manually cancels a
never-paid booking (for some unrelated reason, with its own
`Cancellation_Reason__c`) any time in that first 24 hours, this
scheduled path still fires at the 24-hour mark, sees both totals still
at zero, and overwrites that reason with
`"Autocancel Booking due to No Payment in 24 Hours"` — clobbering
whatever the agent actually recorded. Adding a
`Status__c = 'Pending'` check to `Check_for_Payments` would fix this.

**Fixed:** `Check_for_Payments` now also requires
`Booking_Record_After_24_Hours.Status__c != 'Cancelled'` before
auto-cancelling.

**Minor:** the requirement frames abandonment as "no payment activity
*or modifications*"; only the payment-activity half is implemented —
a booking that was edited but still unpaid is still auto-cancelled at
24 hours. Likely the dominant signal anyway, but worth knowing it's a
partial implementation of that clause.

## Booking cancellation automation

**Requirement:** Block cancelling a booking whose start date has
passed; on cancellation, refund the security deposit (minus a
threshold-driven cancellation charge), refund any rent payment as a
separate adjustment, mark the booking's payment status accordingly, and
close out related open Cases and Tasks.

**Bug — two validation rules now enforce the same rule, inconsistently.**
`Check_Cancellation_After_Start` (built earlier — see the validation
rules section above) and the new `Validation_for_Booking_Cancellation`
both block cancelling a booking whose start date has passed, but they
don't agree:

| | `Check_Cancellation_After_Start` (earlier) | `Validation_for_Booking_Cancellation` (new) |
|---|---|---|
| Guard | None — fires on *any* save of an already-cancelled, past-start booking | `ISCHANGED(Status__c)` — only fires on the actual cancel action |
| Comparison | `Start_Date_Time__c < NOW()` (to the minute) | `DATEVALUE(Start_Date_Time__c) < TODAY()` (whole day) |

The new rule is the better-designed one — it doesn't accidentally block
unrelated edits (like adding a note) to an old, already-cancelled
booking the way the old one does, and its date-level (not
minute-level) comparison is arguably a more literal reading of "the
rental start date has not yet passed." But since both are still active,
the *stricter* of the two wins in practice: the old rule's minute-level
cutoff still applies, and its missing `ISCHANGED` guard still blocks
harmless edits to old cancelled bookings. Recommend deactivating
`Check_Cancellation_After_Start` now that its replacement exists.

**Fixed:** `Check_Cancellation_After_Start` is now deactivated.

**`Post Booking Cancellation Automation`** (after-save, on update,
`Status__c` changes to `Cancelled`): the two halves of the requirement
are deliberately decoupled — refund creation runs synchronously
(needed before the interview ends), while closing related Cases/Tasks
runs on an `AsyncAfterCommit` scheduled path (doesn't depend on the
payment logic at all, so it always runs regardless of payment
outcome, and doesn't block the main transaction). That's a genuinely
good design choice, not just a default.

Refund logic: if the security deposit was paid, looks up the
`Cancelled_Percentage` threshold (the same one documented earlier) and
creates a `Refund` payment transaction for
`deposit - deposit * (cancelled% / 100)`. If rent was paid, creates a
separate `Adjustment` transaction for the *full* rent amount (correctly
not reduced by the cancellation percentage, which per the requirement
only applies to the deposit). Both `Type__c` values are real, valid
picklist entries. `Payment_Status__c` is set to `Refunded` — the
requirement's text says `"Refund"`, but `Refunded` is the field's
actual picklist value, so the implementation correctly used the real
one rather than the requirement's casual paraphrase.

**Gap — no fault handling anywhere in this flow.** Every other
autolaunched flow in this project (the coupon approval flow, the
booking estimator, and the sibling "After Save activity" flow above)
routes failures to the `Log__e` logging pipeline. This flow has no
`faultConnector` on any of its four DML elements — a failure here (a
bad picklist value, a validation rule conflict, a permissions issue)
would fail silently from this project's point of view, visible only as
Salesforce's default flow-fault email to the running user. Worth
bringing in line with the rest of the project's flows.

**Minor:** `Is_Payment_Transactions_records_available`'s decision has
no default-outcome connector, but tracing the possible paths into it,
the collection can never actually be empty there given how the earlier
decisions gate entry — dead code today, not a live bug, but worth a
default connector anyway for robustness against future changes.

## Primary car image synchronization

**Requirement:** Only one image per car can be primary at a time; when
a new image is marked primary, all other images for that car become
non-primary and the car's `Primary_Image_Url__c` reflects the new
choice; a primary image can't be deleted.

**`Prevent Deletion Of Primary Image`**: a before-delete flow on
`Car_Image__c`, filtered to `Primary_Image__c = true`, blocking with a
custom error. Simple and correct — matches the requirement exactly.

**`Sync Primary Image`**: after-save (create or update) on
`Car_Image__c`, filtered to `Primary_Image__c = true`. Looks for
another image on the same car, marks it non-primary, then updates the
car's `Primary_Image_Url__c` from the newly-primary image — the right
shape for the requirement.

**Bug — the "find the other primary image" query doesn't check for
primary.** `Get_Existing_Primary_Image` filters only on
`Car__c = $Record.Car__c` and `Id != $Record.Id` — it has no
`Primary_Image__c = true` filter, so it returns *some other image* on
the car, not specifically *the currently-primary one*. With no `ORDER
BY`, which one it happens to return is unpredictable. Concretely: a
car with three images (A = primary, B and C = not) — mark B as primary,
and this query might return C instead of A. The flow then unsets C
(already `false`, a no-op) and leaves A still marked primary, so the
car ends up with **two** primary images (A and B) at once — the exact
invariant this flow exists to enforce. Needs
`Primary_Image__c = true` added to `Get_Existing_Primary_Image`'s
filters.

**Not a bug, out of scope:** if a user unchecks the current primary
image's `Primary_Image__c` without marking a replacement, this flow
never fires (it only triggers when `Primary_Image__c` becomes `true`),
so the car's `Primary_Image_Url__c` is left pointing at an image that's
no longer flagged primary. The requirement only specifies behavior for
*marking* a new primary, not un-marking one, so this isn't a
requirement mismatch — just a real gap if that scenario matters in
practice.

This work also added a second CSP Trusted Site
(`Creta_Car_Image_1`, `encrypted-tbn0.gstatic.com`, img-src) — a
second trusted image host alongside the earlier `Car_Images_API` one,
presumably for a sample/test image URL sourced from Google's image
cache rather than the S3 bucket used before. Routine, not
business-logic-bearing.
