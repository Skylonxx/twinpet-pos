# Baseline Risk Review

## Architecture

- Offline-first POS makes sale intent client-authoritative while settlement is delayed to Cloud Functions.
- Sales have multiple sources of truth: `asyncOrders` plus canonical `orders`, `orderItems`, and `payments`.
- Core business logic is duplicated between frontend and Cloud Functions.
- Client write access remains broad for inventory and sales collections despite server-authoritative flows.
- Dev/mock paths skip important production behavior such as lot simulation and reconciliation.

## Inventory

- POS sales intentionally tolerate oversell and can drive `totalStockBase` negative.
- Oversold quantities use virtual lot refs instead of real lot documents.
- Lot discovery happens before client transactions for adjustments, transfers, and receiving ghost lots.
- `avgCost` is stored on product documents while actual valuation is lot-based.
- Transfer edit is two sequential transactions: cancel original, then create edited transfer.

## Firestore

- `products/{productId}/productStocks/{stockBranchId}` allows any staff write.
- `stockLots` allows any staff create/update.
- Child collection creates such as `orderItems`, `payments`, `receivingItems`, `adjustmentItems`, and `transferItems` are broadly staff-writable.
- POS uses fire-and-forget `setDoc` for `asyncOrders`.
- Reconciliation exceptions have no completed stale retry/alerting path.
