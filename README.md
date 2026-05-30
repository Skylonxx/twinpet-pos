# 🐾 TwinPet POS

A modern, multi-branch **Point-of-Sale & Inventory Management** system for pet retail, built with React 19, TypeScript, and Firebase. TwinPet POS handles the full retail lifecycle — selling, receiving stock, FIFO costing, customer credit, cash-drawer shifts, and cross-branch reporting — from a single, fast, touch-friendly interface.

> 🛠️ **Status:** The codebase was **completely refactored and architecturally optimized as of May 2026** — see [Refactoring & Optimization](#-refactoring--optimization-may-2026).

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Core Features](#-core-features)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
- [Available Scripts](#-available-scripts)
- [Refactoring & Optimization (May 2026)](#-refactoring--optimization-may-2026)

---

## 🔎 Overview

**TwinPet POS** is a production retail platform designed for pet shops operating one or many branches. It combines a cashier-facing POS terminal with back-office tools for inventory, purchasing, customers, staff, and financial reporting.

Highlights:

- **Multi-branch aware** — every product, stock level, sale, and report is scoped by branch, with a dedicated Admin area for HQ-level, cross-branch oversight.
- **Real money discipline** — all monetary math is centralized and rounded to satang (2 decimals) to avoid floating-point drift in totals and change.
- **FIFO inventory costing** — cost of goods sold is computed lot-by-lot, oldest stock first, inside atomic Firestore transactions.
- **Offline-friendly dev mode** — when Firebase isn't configured, the app falls back to rich in-memory mock data so the entire UI is explorable locally.
- **Thai-first UX** — labels, currency (฿), and date formatting are localized for Thai retail operations.

---

## 🏗 Architecture

TwinPet POS follows a clean separation between **UI components**, **reusable logic hooks**, and a **domain/data layer**.

### Tech Stack

| Layer | Technology |
|---|---|
| UI framework | **React 19** + **TypeScript** |
| Build tool | **Vite 8** |
| Routing | **React Router 7** |
| Backend / data | **Firebase** (Firestore, Auth, Cloud Functions) |
| Charts | **Chart.js** + `react-chartjs-2` |
| Auth hashing | `bcryptjs` (PIN login) |
| Testing | **Playwright** (E2E) |
| Quality | **ESLint** (typescript-eslint, react-hooks, react-refresh) |

### Layered design

```
┌─────────────────────────────────────────────────────────┐
│  Pages (src/pages)          UI orchestrators & screens     │
│  Components (src/components) Presentational + modals        │
├─────────────────────────────────────────────────────────┤
│  Custom Hooks                                              │
│    • src/hooks/pos/useCart      cart state & line logic     │
│    • src/hooks/pos/useCheckout  customer, sale, CRM update   │
│    • src/lib/**/use*.ts         data-fetching hooks          │
├─────────────────────────────────────────────────────────┤
│  Domain / Utilities (src/lib)                              │
│    • money.ts        satang rounding & formatting           │
│    • fifo.ts         FIFO sale transaction                  │
│    • pos/, stockReport/, profitReport/, customers/, …       │
├─────────────────────────────────────────────────────────┤
│  Firebase (src/lib/firebase.ts)   Firestore • Auth • Funcs  │
└─────────────────────────────────────────────────────────┘
```

### Design principles

- **Logic lives in hooks, not components.** Pages such as `POSPage` and `StockReportPage` act as thin orchestrators that compose focused hooks and presentational components. Complex screens are split into per-tab components that mount/unmount with their own local state.
- **Pure, testable utilities.** Calculations (cart totals, FIFO cuts, sorting, money rounding) live in plain functions under `src/lib`, independent of React.
- **One source of truth for money.** [`src/lib/money.ts`](src/lib/money.ts) exposes `roundMoney()` and `formatMoney()`; every persisted or compared amount flows through them.
- **Branch-scoped data fetching.** Hooks accept a `branchId` and subscribe only to the relevant slice of Firestore, with graceful index-missing fallbacks.

---

## ✨ Core Features

### 🛒 Cart
- Touch-first product grid with category filters, search, and **barcode/SKU scanning** (including per-UOM barcodes).
- Multi–unit-of-measure (UOM) support with automatic price resolution.
- **Tier-based pricing** — line prices re-derive automatically from the selected customer's pricing tier.
- Per-line discounts (฿ / % / price override), bill-level discount, and configurable service fees.
- **Hold & restore bills** (suspended sales) and quick cart-clear.
- Cart logic is encapsulated in [`useCart`](src/hooks/pos/useCart.ts).

### 💳 Checkout
- Split-payment support: cash, QR, bank transfer, card, and **credit**.
- Live change calculation and receipt preview.
- Records the sale atomically (order, line items, payments, stock movements) and updates CRM lifetime value & loyalty points.
- Checkout logic is encapsulated in [`useCheckout`](src/hooks/pos/useCheckout.ts).

### ⚠️ Credit & Overdue Warnings
- Customers can buy on credit; a `creditLimit` of `0` means **unlimited** credit by policy.
- On a credit sale, the system checks for **overdue unpaid invoices** (orders past `createdAt + creditDays`).
- Overdue balances raise a **soft warning** to the cashier — *"ลูกค้ามียอดค้างชำระเกินกำหนดเวลา (Overdue)"* — **without blocking** the sale, so the front line keeps moving while finance stays informed.

### 📦 FIFO Inventory
- Stock is tracked as dated **lots**; sales consume the **oldest lot first** (First-In-First-Out).
- COGS is computed lot-by-lot inside a single Firestore transaction (reads-before-writes, conflict-free lot merging), keeping valuation accurate.
- **Stock Report** screen (Overview / Products / FIFO Queue / Movement tabs) with charts, low-stock alerts, expiry tracking, and CSV export.
- Goods receiving (GRN), inventory adjustments, and **cross-branch transfers** all feed the lot ledger.

### ⏱ Shift Management
- Cashiers **open and close shifts** with a starting float; expected cash/QR/card/credit totals accrue per sale.
- **Cash in/out** transactions during a shift are logged to the drawer.
- Closing a shift reconciles expected vs. counted cash and starts a fresh sale session.

### 🧰 Plus
- **Admin / HQ area** — consolidated multi-branch dashboards, product & supplier catalogs, branch & staff management, and an all-branches stock overview.
- **Reporting** — profit report, sales history, receivables, and exportable stock reports.
- **Auth** — PIN-based cashier login and username/password admin login, with branch-access enforcement.

---

## 📁 Project Structure

```
src/
├── pages/              Screen-level components (POS, Dashboard, reports, admin/…)
├── components/         Presentational UI & modals
│   ├── common/         Shared widgets (e.g. DateRangeDropdown)
│   ├── pos/            POS modals (payment, UOM, numpad, shift, suspended bills)
│   ├── stockReport/    Stock report tabs (Overview / Products / FIFO / Movement)
│   └── customers/ products/ receiving/ …
├── hooks/
│   └── pos/            useCart, useCheckout  (POS business logic)
├── lib/
│   ├── money.ts        Centralized satang rounding & formatting
│   ├── fifo.ts         FIFO sale transaction (completePosSale)
│   ├── firebase.ts     Firebase initialization
│   ├── pos/            Cart utils, tier pricing, shift service, bill IDs
│   ├── stockReport/    Stock aggregation, sorting, CSV export
│   ├── customers/      CRM, credit service, tiers
│   ├── profitReport/ salesHistory/ receiving/ inventory/ dashboard/
│   ├── auth/           Auth provider, PIN verification, sessions
│   └── settings/ admin/ documents/
└── layouts/            App shells (POS shell, Admin layout, Settings layout)
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** 20+ (the toolchain targets Node 24 types)
- A **Firebase** project (optional for local exploration — see dev mode below)

### Install

```bash
npm install
```

### Configure environment

Copy the example env file and fill in your Firebase credentials:

```bash
cp .env.example .env.local
```

> 💡 **Dev mode without Firebase:** if Firebase isn't configured, the app automatically serves realistic in-memory mock data so you can browse the full UI locally.

### Run

```bash
npm run dev
```

Then open the printed local URL (Vite default: `http://localhost:5173`).

---

## 📜 Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the Vite dev server with HMR |
| `npm run build` | Type-check (`tsc -b`) and build for production |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run ESLint across the project |
| `npm test` | Run Playwright end-to-end tests |
| `npm run test:ui` | Run Playwright in interactive UI mode |
| `npm run test:headed` | Run Playwright with a visible browser |

---

## 🔧 Refactoring & Optimization (May 2026)

The codebase underwent a **complete architectural refactor and optimization pass in May 2026**, guided by a full technical audit. Key outcomes:

- **Money correctness** — introduced [`src/lib/money.ts`](src/lib/money.ts) with strict satang rounding (`roundMoney`) and a single `formatMoney`, applied across cart math and the FIFO sale transaction to eliminate floating-point drift in stored totals, change, and COGS.
- **Credit term logic** — credit overdue is now a **soft warning** (non-blocking), respecting the "0 = unlimited credit" business rule while still flagging overdue balances based on each customer's credit term.
- **`POSPage` decomposition** — extracted cart and checkout state into dedicated hooks (`useCart`, `useCheckout`), turning the page into a lean UI orchestrator and breaking up a previously monolithic component.
- **`StockReportPage` decomposition** — split the largest screen into focused per-tab components (`StockOverviewTab`, `StockProductsTab`, `StockFifoTab`, `StockMovementTab`) plus shared utilities (`DateRangeDropdown`, sorting helpers), so inactive tabs unmount and reset their own state.
- **Deactivation & alert muting** — products support `isActive` (hidden from POS & reports, reactivatable) and `muteAlerts` (excluded from low/critical/out-of-stock warnings, e.g. for seasonal items).
- **Render & data hygiene** — replaced effect-driven state syncs with derived values where possible, tightened query scoping, and kept the project **`tsc` and ESLint clean**.

---

<p align="center"><em>Built with care for pet shops. 🐶🐱</em></p>
