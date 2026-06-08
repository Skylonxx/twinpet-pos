# Phase 7 Pre-Flight Codebase State Audit

## Executive Summary
The codebase contains a sophisticated, production-grade offline-first inventory system with strict Firestore rule constraints and complex atomic operations. Core features like FIFO costing, Goods Receiving, and Branch Transfers are heavily built out and deeply integrated with the UI and Firestore rules. 

**What is safe to preserve**: The core FIFO data model (`StockLot`, `StockMovement`), offline POS checkout + server-side reconcile function (`reconcileOrder.ts`), Branch Transfers (`transferCrud.ts`), and the deliberate constraints in `firestore.rules`.
**What appears half-finished**: UI-side Role/Permission enforcement. The backend enforces strict boundaries, but UI routing/button hiding is naive. Returns are conflated with Stock Adjustments and Voided Orders without a dedicated line-item return flow.
**What appears stubbed**: `UserPermissions` exist in types but are functionally ignored in the UI layer.
**What is missing**: Sales Promotions logic (completely absent), Partial Receiving, and Transfer Discrepancy handling.
**Biggest risk areas**: 
1. **FIFO Duplication Risk**: Any attempt to reimplement FIFO or Receiving would overwrite or conflict with the already robust transaction logic (e.g. `src/lib/fifo.ts` vs `functions/src/reconcileOrder.ts`).
2. **Security Mismatch Risk**: The mismatch between the guarded Firestore rules and the naive React UI permissions could lead to opaque `PERMISSION_DENIED` errors for users if features are built without matching frontend UI guards to backend rules.

---

## 1. Inventory / FIFO
* **Types/Schema**: `StockLot`, `StockMovement`, and `LotRef` inside `OrderItem` / `AsyncOrderLine` are defined in `src/lib/types.ts`.
* **Product Stock Fields**: `ProductStock.totalStockBase` stores denormalized stock qty.
* **Batch/Lot Model**: `StockLot` tracks `receivedAt`, `costPerUnit`, `qtyReceived`, `qtyRemaining`, `expiryDate`, `isGhost`, and `isDepleted`.
* **Cost Fields**: `Product` has manual `cost` and moving-average `avgCost`. `OrderItem` has `fifoCost` (COGS).
* **FIFO Mutating Paths (Must Preserve!)**:
  - `src/lib/fifo.ts`: Contains the shared client-side logic (`planFifoCutFromState`) for INVENTORY mutations (e.g., transfers, adjustments).
  - `functions/src/reconcileOrder.ts`: Contains a **duplicated** server-side version of `planFifoCutFromState` because Cloud Functions cannot easily import from the React `src/lib`. This is the authoritative checkout mutator.
  - `src/lib/inventory/confirmInventoryAdjustment.ts`: Deducts stock and consumes FIFO lots for manual adjustments (`ADJUST_OUT`).
  - `functions/src/voidReversal.ts`: Adds stock back to `qtyRemaining` of the exact original FIFO lots when an order is voided.
* **Duplication Risk**: Phase 7 MUST NOT create a third FIFO implementation. The client/server split is intentional, but modifying one without the other will cause divergence.
* **Classification**: **Complete and wired**.

## 2. Goods Receipt / รับเข้า
* **Final Receiving Transaction**: Handled by `src/lib/receiving/confirmReceiving.ts`. This performs the transactional FIFO layer creation (`StockLot`) and average cost calculation.
* **Draft Save**: Handled by `src/lib/receivingHistory/saveReceivingDraft.ts`. Writes a `draft` status GRN without mutating stock.
* **Update/Edit Receiving**: Handled by `src/lib/receivingHistory/updateReceiving.ts` (modifies draft) and edit logic inside `confirmReceiving.ts` for finalizing edits.
* **Cancel Receiving**: Handled by `src/lib/receivingHistory/cancelReceiving.ts`. Cancels a draft/completed GRN (reverses stock if completed).
* **Receiving History Hook**: `useReceivingHistory.ts` provides the list and read capabilities for the UI.
* **UI Integration**: Fully wired via `ReceivingPage.tsx`, `ReceivingEditPage.tsx`, and `ReceivingHistoryPage.tsx`.
* **Classification**: **Complete and wired** (All subflows: final, draft, update, cancel, history are fully implemented).

## 3. Branch Transfer / โอนออก
* **Page/Component**: Exists (`src/pages/inventory/BranchTransferPage.tsx`, `src/pages/inventory/TransferHistoryPage.tsx`, `src/pages/inventory/TransferPage.tsx`, `src/pages/admin/AdminTransferPage.tsx`).
* **Source/Destination Branch Model**: Modeled via `fromBranchId` and `toBranchId` on `InventoryTransfer` (`src/lib/inventory/transferTypes.ts`).
* **Stock Deduction/Inbound**: Fully atomic. Deducts from source `StockLot` and instantly creates a corresponding `StockLot` at the destination via `src/lib/inventory/transferCrud.ts`.
* **FIFO Usage**: Cuts from source FIFO layers and preserves cost logic.
* **Firestore Transaction Usage**: Implemented inside `transferCrud.ts`.
* **Classification**: **Complete and wired**.

## 4. Returns / คืนของ
* **Customer Return**: 
  - Modeled as an inventory adjustment. `ADJUSTMENT_REASONS` inside `src/lib/inventory/types.ts` contains `รับคืนจากลูกค้า`.
  - Alternatively handled by voiding the entire order (`functions/src/voidReversal.ts`, `src/pages/SalesHistoryPage.tsx` using `ยกเลิกบิล`).
* **Stock Effect / FIFO**: Voiding reverses FIFO consumption. Adjusting adds/removes a `StockLot`.
* **Permissions**: Driven by `pos_void` backend rule.
* **Sales/Order Linkage**: Full-order voids are linked to `Order`. Line-item return is missing.
* **Classification**: **Partially supported** (No dedicated line-item return flow; conflated with voiding/adjusting).

## 5. Partial Receiving / Transfer Discrepancy
* **Search Evidence**: 
  - Searched `partial|expectedQuantity|receivedQuantity|remainingQuantity|backorder|draft|pending|receiving status` in `src/lib/receivingHistory` and `src/lib/receiving`. Only `draft`, `completed`, `cancelled`, and `pending` (payStatus) were found. No expected vs received qty logic exists.
  - Searched `discrepancy|damaged|lost|shortage|overage|shippedQuantity|receivedQuantity|resolve discrepancy|transfer adjustment` in `src/lib/inventory`. Zero results found.
* **Expected vs Received Qty Fields**: Missing.
* **Discrepancy Reason/Status**: Missing.
* **Backorder Handling**: Missing.
* **Classification**: **Missing**.

## 6. Security / Roles
* **1. Backend Custom Claims (Tokens)**: Granular permission keys like `pos_sale`, `pos_void`, `product_edit`, `stock_receive` are minted into the user's auth token by the login function.
* **2. User Profile Role Model**: `UserRole = 'admin' | 'manager' | 'staff'` and `UserPermissions` definition exists in `src/lib/types.ts` and `src/lib/staffManagement/types.ts`.
* **3. Frontend Derived Object**: The UI derives permissions into a `UserPermissions` object (e.g., `canVoidOrder`, `canManageStock`), but rarely uses them.
* **4. UI Enforcement**: `src/components/PosShellRoute.tsx` primarily enforces branch-level access (`branchId`), not specific roles. `AdminLayout.tsx` uses `isGlobalAdmin` to toggle the workspace selector but doesn't block routes. No central `usePermissions` hook hides buttons.
* **5. Firestore Rules Enforcement (Intentional Constraints)**: 
  - The backend rules are highly deliberate constraint boundaries, not a blanket "secure" wall.
  - `stockLots` intentionally allows `read: if isStaff()` for cross-branch transfer planning.
  - `canMutateStock()` deliberately includes `product_view` to allow regular staff to execute transfers.
  - Some `productStocks` paths intentionally allow cross-branch writes to support instant `transferCrud.ts` execution.
* **Mismatch Risk**: The UI is dangerously naive. It exposes actions without checking the frontend permission object, relying entirely on the backend to throw `PERMISSION_DENIED`. Phase 7 must carefully preserve the deliberate firestore rule exceptions and fix the UI to match.
* **Classification**: **UI + Firebase mismatched** (Backend has deliberate constraints; UI lacks equivalent enforcement).

## 7. Sales / Promotions
* **Search Evidence**: 
  - Searched `promotion|promo|discount|coupon|campaign|member price|manual discount` in `src/lib/`. 
  - Found manual `discountAmt` and `billDiscount` in `cartUtils.ts`, `types.ts`, and test mocks. Found `ItemDiscountType = 'none' | 'disc_thb' | 'disc_pct' | 'override'`.
  - Found NO evidence of automated rule engines, "buy X get Y", bundle logic, or date-limited promotions.
* **Promotion Service/Hook**: Missing.
* **Cart Calculation**: Cart supports manual subtraction (`billDiscount`), but no automated promotional calculation engine.
* **Classification**: **Missing**.

---

## Existing Code We Must Preserve
- **Offline Sync & Reconciliation**: `asyncOrders` logic and `functions/src/reconcileOrder.ts` MUST NOT be overwritten.
- **Inventory FIFO Deductions**: `src/lib/fifo.ts` (client) and `functions/src/reconcileOrder.ts` (server).
- **Inventory & Costing**: `src/lib/receivingHistory/*` (drafts/finals) and `src/lib/inventory/transferCrud.ts`.
- **Firestore Rules**: `firestore.rules` is highly customized with deliberate read/write exceptions for transfers.

## Existing Code That Looks Stubbed or Half-Finished
- **UI Permission Guards**: `UserPermissions` exist in types (`canVoidOrder`, `canManageStock`) but are functionally ignored in the UI layer.

## Missing Modules
- **Sales Promotions**: Needs a full backend data model and cart integration engine.
- **Partial Receiving / Transfer Discrepancy**: Needs dedicated states and discrepancy log tables.
- **Line-item Returns / Refunds**: Needs a dedicated Refund workflow distinct from full-order voids.

## Duplication / Conflict Risks
- **Inventory Replacements**: Re-writing goods receipt or transfers from scratch will severely conflict with existing robust transaction logic and cause schema mismatch (e.g., ignoring `isGhost` properties).
- **FIFO Divergence**: Modifying FIFO logic requires simultaneously updating `src/lib/fifo.ts` and `functions/src/reconcileOrder.ts`.
- **Role Enforcement**: Adding frontend role enforcement without matching `firestore.rules` claims.

## Recommended Phase 7 Backlog Implications
1. **Promotions**: Must be built from scratch, ensuring it integrates cleanly with offline `asyncOrders`.
2. **Partial Receiving/Transfers**: Requires extending existing `Receiving` and `InventoryTransfer` types without breaking current `completed` workflows.
3. **Role UI Alignment**: UI must be updated to respect the `permissions` object to avoid opaque `PERMISSION_DENIED` errors from Firestore rules.
4. **Returns**: Consider splitting "Returns" into its own module rather than overloading `InventoryAdjustment`.
