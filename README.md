# Car Rentals

A personal Salesforce project implementing a car rental management data
model — vehicle inventory, bookings, payments, reviews, coupons, and
support cases — built as a standard Salesforce DX project.

## Data Model

Core custom objects, plus extensions to standard `Contact` and `Case`:

| Object | Purpose | Key relationships |
|---|---|---|
| **Car__c** | Vehicle inventory: make, model, year, rental rate, mileage limit, service dates, real-time availability | Master-Detail parent of `Car_Image__c`; looked up from `Booking__c`, `Case.Related_Car__c` |
| **Booking__c** | Customer reservations: car, customer, rental period, status (Pending/Confirmed/Cancelled) | Lookup to `Car__c` and `Contact` (both required), `Coupon_Code__c` (optional, active coupons only); Master-Detail parent of `Payment_Transaction__c`; looked up from `Review__c`, `Case.Related_Booking__c` |
| **Payment_Transaction__c** | Payment/refund/deposit ledger per booking | Master-Detail child of `Booking__c` |
| **Car_Image__c** | Vehicle photos, with a primary-image flag | Master-Detail child of `Car__c` |
| **Review__c** | Customer ratings/comments per booking | Lookup to `Booking__c` and `Contact`; looked up from `Case.Review_ID__c` |
| **Coupon_Code__c** | Discount codes: expiry, usage limits, manager approval for large discounts | Looked up from `Booking__c` |
| **LogEvent__c** | Technical log of Flow/Apex errors and warnings | Standalone |
| **Contact** (standard) | Customer record, extended with `Total_Lifetime_Spending__c` and `Total_Number_Of_Booking__c` | |
| **Case** (standard) | Support cases, extended with `Related_Booking__c`, `Related_Car__c`, `Review_ID__c`, `Resolution_Notes__c` | |

`Total_Bookings_Value__c` (Car), `Total_Lifetime_Spending__c` /
`Total_Number_Of_Booking__c` (Contact), and `Average_Rating__c` /
`Current_Average__c` (Car) are plain editable fields, not native roll-up
summaries — their parent relationships are Lookups rather than
Master-Detail, so these are meant to be kept in sync by Flow/Apex.

Access is currently controlled by a single **Car On Rental** permission
set (admin use).

## Prerequisites

Before you start, make sure you have:

- **Salesforce CLI** - Download from [developer.salesforce.com/tools/salesforcecli](https://developer.salesforce.com/tools/salesforcecli). See [Install Salesforce CLI](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_install_cli.htm) for details.
- **VS Code with Salesforce Extension Pack** - See [Installation Instructions](https://developer.salesforce.com/docs/platform/sfvscode-extensions/guide/install.html) for details. Includes the Agentforce Vibes extension.
- **A development org** - Sign up for a free Developer Edition org [here](https://developer.salesforce.com/signup).
- **Dev Hub enabled** (optional, required to create scratch orgs) - You can enable Dev Hub in your development org under Setup > Dev Hub.  See [Provide Developers Access to Salesforce DX Tools](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_setup_dx_tools.htm).

## Project Structure

Your DX project follows this structure:

- **`force-app/main/default/`** - Your metadata source files live in this default package directory. You can configure additional package directories in the `sfdx-project.json` file.
- **`config/`** - Scratch org definitions and project settings
- **`scripts/`** - Automation scripts for common tasks
- **`sfdx-project.json`** - Project manifest that defines package directories, namespace, API version, and other project-level settings

See [Salesforce DX Project Configuration](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_ws_config.htm).

## Get Started

Ready to start developing? The [Get Started with Salesforce DX](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_get_started_dx.htm) guide walks you through your first project, from creating a scratch org to creating a simple Apex class or LWC to deploying your code to a sandbox.

## Common Salesforce CLI Commands

Here are common CLI commands that you'll use the most:

- `sf org login web`: Authorize an org
- `sf org open`: Open your org in a browser
- `sf org create scratch`: Create a scratch org
- `sf project deploy start`: Deploy metadata to your org
- `sf project retrieve start`: Retrieve metadata from your org
- `sf template generate <artifact>`: Scaffold new components, such as Apex classes and triggers, LWC components, Lightning apps, and more
- `sf apex <command>`: Run Apex tests, run anonymous Apex blocks, and view logs
- `sf data <command>`: Work with test data
- `sf alias <command>`: Manage org aliases
- `sf config <command>`: Configure CLI settings

## Use Agentforce Vibes to Build Lightning Apps

Transform your ideas into custom Lightning apps that extend CRM workflows directly in Lightning Experience. Through natural conversations with Agentforce Vibes, implement custom objects and fields, complex business logic, and dynamic UI components. See [Build a Lightning App Using Agentforce Vibes](https://developer.salesforce.com/docs/platform/einstein-for-devs/guide/lexapp-overview.html).

## Additional Resources

- [Agentforce Vibes Developer Guide](https://developer.salesforce.com/docs/platform/einstein-for-devs/guide/einstein-overview.html)
- [Salesforce CLI Installation Guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_intro.htm)
- [Salesforce DX Developer Guide](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/)
- [Salesforce CLI Command Reference](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/)
- [Salesforce CLI Plugin Development Guide](https://developer.salesforce.com/docs/platform/salesforce-cli-plugin/guide/conceptual-overview.html)
- [Salesforce VS Code Extensions Documentation](https://developer.salesforce.com/tools/vscode/)

