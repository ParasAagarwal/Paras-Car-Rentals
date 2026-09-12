# Paras Car Rentals

A personal Salesforce project built end-to-end on Salesforce DX: a car
rental management system covering vehicle inventory, bookings, payments,
reviews, coupons, and support cases — with a full declarative and
programmatic build (custom objects and automation, Apex, a security
model, integrations, a multi-component LWC app, and an Agentforce agent)
all built and retrieved from a real org.

## What's in it

- **Vehicle & booking lifecycle** — cars, bookings, and payments modeled
  with Flow- and Apex-driven business rules: availability checks, overlap
  prevention, pricing calculation, mileage limits, and a booking status
  lifecycle from Pending through Completed/Cancelled.
- **Coupons & reviews** — discount codes with expiry, usage limits, and
  manager approval above a configurable threshold; post-booking customer
  reviews feeding a rolled-up car rating.
- **Case management** — support cases categorized by record type
  (billing, vehicle issue, general), linked back to the originating
  booking, car, or review.
- **Configurable thresholds** — business values (discount limits, deposit
  percentage, log retention, etc.) live in a custom metadata type instead
  of being hardcoded, so admins can tune them without a deploy.
- **Security model** — a dedicated profile and permission set layered
  over a CEO → Supervisor → Representative Agent role hierarchy, with
  object-level sharing (private/public/controlled-by-parent) and
  criteria-based sharing rules matched to how sensitive each object is.
- **Trigger & logging framework** — built on Salesforce's open-source
  `apex-recipes` pattern: metadata-driven trigger handlers with an
  admin-configurable enable/disable switch per object, and a durable
  platform-event-backed log of Flow/Apex errors and warnings.
- **Scheduled maintenance & external integrations** — batch jobs for
  recurring cleanup/status maintenance, plus an outbound integration to
  an external service for email reputation checks.
- **Car Hunt** — a multi-component Lightning Web Component app (filter
  panel, results grid, detail card, booking and estimate modals) for
  searching and booking a car entirely from a custom Lightning app page.
- **Car Fleet Assistant (Agentforce)** — an Agentforce agent, authored
  directly in Agent Script, that reads a car's specs plus its recent
  bookings and cases, generates a plain-language status summary, and
  writes it back onto the record — chaining a prompt-template action and
  a flow-based write-back action in one agent turn. Restricted to
  Managers and Admins, and built as a deliberate showcase of Agent
  Script authoring, prompt templates, and flow-based grounding/actions
  together (one of several valid ways to build this capability, not the
  only one).

See [docs/requirements-and-design.md](docs/requirements-and-design.md)
for the full requirement-by-requirement breakdown of every area above.

## Data Model

Core custom objects, plus extensions to standard `Contact` and `Case`:

| Object | Purpose | Key relationships |
|---|---|---|
| **Car__c** | Vehicle inventory: make, model, year, rental rate, mileage limit, service dates, real-time availability | Master-Detail parent of `Car_Image__c`; looked up from `Booking__c`, `Case.Related_Car__c` |
| **Booking__c** | Customer reservations: car, customer, rental period, status (Pending → Confirmed → Started → Completed → Cancelled/Closed) | Lookup to `Car__c` and `Contact` (both required), `Coupon_Code__c` (optional, active coupons only); Master-Detail parent of `Payment_Transaction__c`; looked up from `Review__c`, `Case.Related_Booking__c` |
| **Payment_Transaction__c** | Payment/refund/deposit ledger per booking | Master-Detail child of `Booking__c` |
| **Car_Image__c** | Vehicle photos, with a primary-image flag | Master-Detail child of `Car__c` |
| **Review__c** | Customer ratings/comments per booking | Lookup to `Booking__c` and `Contact`; looked up from `Case.Review_ID__c` |
| **Coupon_Code__c** | Discount codes: expiry, usage limits, manager approval for large discounts | Looked up from `Booking__c` |
| **LogEvent__c** | Durable log of Flow/Apex errors and warnings, fed by a platform event pipeline | Standalone |
| **System_Thresholds__mdt** | Custom metadata holding admin-configurable business values (discount limits, deposit %, log retention, etc.) | Referenced by formulas, Flows, and Apex throughout |
| **Contact** (standard) | Customer record, extended with `Total_Lifetime_Spending__c`, `Total_Number_Of_Booking__c`, `Email_Verified__c` | |
| **Case** (standard) | Support cases, extended with `Related_Booking__c`, `Related_Car__c`, `Review_ID__c`, `Resolution_Notes__c`, and three category-specific Record Types | |

`Total_Bookings_Value__c` (Car), `Total_Lifetime_Spending__c` /
`Total_Number_Of_Booking__c` (Contact), and `Average_Rating__c` (Car)
are plain editable fields, not native roll-up summaries — their parent
relationships are Lookups rather than Master-Detail, so they're kept in
sync by Apex triggers instead.

Access is controlled by a `Car Rental Representative` profile and a
`Rental Manager Permissions` permission set, layered over a
CEO → Supervisor → Representative Agent role hierarchy.

## Project Structure

Standard Salesforce DX layout:

- **`force-app/main/default/`** — all metadata source (objects, flows,
  Apex classes/triggers, LWC, permission sets, prompt templates, and the
  Agentforce agent bundle).
- **`docs/requirements-and-design.md`** — the requirement behind every
  feature area and how it's built.
- **`sfdx-project.json`** — project manifest (package directories,
  source API version).

## Prerequisites

- **Salesforce CLI** — [developer.salesforce.com/tools/salesforcecli](https://developer.salesforce.com/tools/salesforcecli)
- **VS Code with Salesforce Extension Pack** — [install guide](https://developer.salesforce.com/docs/platform/sfvscode-extensions/guide/install.html)
- **A Salesforce org** — a free Developer Edition org works: [sign up here](https://developer.salesforce.com/signup)

## Common Salesforce CLI Commands

- `sf org login web` — Authorize an org
- `sf project deploy start` — Deploy metadata to your org
- `sf project retrieve start` — Retrieve metadata from your org
- `sf apex run` / `sf apex tail log` — Run anonymous Apex / tail debug logs
