# TwinPet POS — Firestore Database Schema
> NoSQL / Firebase Firestore · อัปเดต: พฤษภาคม 2569

---

## 📐 หลักการออกแบบ

| หลัก | รายละเอียด |
|------|-----------|
| Multi-branch | ทุก collection ที่ขึ้นกับสาขาจะมี `branchId` เสมอ |
| FIFO Costing | stock แยก lot, ตัดสต็อกจาก `stockLots` ตามลำดับ `receivedAt` |
| **Atomic Operations** | ⚡ ทุก stock write ต้องใช้ **Firestore Transaction** ห้ามอัปเดตทีละจุด |
| **Denormalized Stock** | ⚡ เก็บ `totalStockBase` ใน `productStocks/{branchId}` แก้ปัญหา N+1 Query |
| Soft Delete | ใช้ `deletedAt: Timestamp \| null` แทนการลบจริง |
| Selective Audit | บันทึก `auditLogs` เฉพาะ action sensitive (void/refund/edit price/edit role) เท่านั้น |
| Denormalize ที่จำเป็น | snapshot ชื่อสินค้า/ราคา ตอนสร้างบิล ป้องกันข้อมูลเปลี่ยนย้อนหลัง |

---

## 🗂️ Collections ทั้งหมด

```
firestore/
├── branches/
├── users/
├── products/
│   └── productStocks/    ← denormalized stock per branch
├── stockLots/
├── stockMovements/
├── customers/
├── priceLevels/
├── uomUnits/
├── orders/               ← บิลขาย (confirmed เท่านั้น)
│   └── orderItems/
├── parkedOrders/         ← บิลพัก (Suspended Sales)
│   └── parkedItems/
├── payments/
├── quotations/
│   └── quotationItems/
├── receivings/           ← รับสินค้าเข้า (GRN)
│   └── receivingItems/
├── creditAccounts/       ← บัญชีเชื่อลูกค้า
├── creditTransactions/
├── settings/             ← ตั้งค่าต่อสาขา
├── posDevices/
├── staffActivities/      ← activity log
└── auditLogs/
```

---

## 📄 Schema รายละเอียด

### `branches/{branchId}`
```js
{
  id:           string,          // "LDP-001"
  name:         string,          // "TwinPet ลาดพร้าว"
  address:      string,
  phone:        string,
  email:        string,
  taxId:        string,          // เลขประจำตัวผู้เสียภาษี 13 หลัก
  logoUrl:      string | null,
  isActive:     boolean,
  createdAt:    Timestamp,
  updatedAt:    Timestamp,
}
```

---

### `users/{userId}`
```js
{
  id:           string,          // Firebase Auth UID
  firstName:    string,
  lastName:     string,
  username:     string,
  pin:          string,          // hashed (bcrypt)
  role:         "admin" | "manager" | "staff",
  branchIds:    string[],        // สาขาที่มีสิทธิ์
  permissions:  {                // override ต่อ user
    canVoidOrder:    boolean,
    canEditPrice:    boolean,
    canViewReport:   boolean,
    canManageStock:  boolean,
    canManageStaff:  boolean,
  },
  isActive:     boolean,
  lastLoginAt:  Timestamp | null,
  createdAt:    Timestamp,
  updatedAt:    Timestamp,
  deletedAt:    Timestamp | null,
}
```

---

### `products/{productId}`
```js
{
  id:           string,
  name:         string,
  sku:          string,          // unique
  barcode:      string | null,
  category:     string,          // "อาหารสุนัข"
  description:  string,
  imageUrl:     string | null,
  baseUnit:     string,          // "ชิ้น" — หน่วยฐานเสมอ
  uomConversions: [              // หน่วยย่อย
    {
      unit:       string,        // "กล่อง"
      factor:     number,        // 24 (1 กล่อง = 24 ชิ้น)
    }
  ],
  // ⚡ Array of Objects — query ได้ (เช่น หาสินค้าราคาปลีก < 100)
  prices: [
    {
      priceLevelId: string,      // "RETAIL"
      unit:         string,      // "ชิ้น"
      price:        number,      // 480
    }
    // ... อีกหลาย combination
  ],
  avgCost:      number,          // คำนวณจาก stockLots (display only)
  reorderPoint: number,          // จุดสั่งซื้อ (per branch ใช้ใน productStocks แทน)
  isActive:     boolean,
  createdAt:    Timestamp,
  updatedAt:    Timestamp,
  deletedAt:    Timestamp | null,
}
```

#### `products/{productId}/productStocks/{branchId}`
> ⚡ **Denormalized stock total ต่อสาขา** — แก้ปัญหา N+1 Query  
> อัปเดต atomic ใน transaction เดียวกับ stockLots เสมอ

```js
{
  branchId:        string,
  totalStockBase:  number,       // สต็อกรวมทุก lot (หน่วยฐาน) — ใช้แสดงผลในหน้า POS
  reorderPoint:    number,       // จุดสั่งซื้อ ต่อสาขา
  lastMovementAt:  Timestamp,    // ใช้ตรวจ stale data
  updatedAt:       Timestamp,
}
```

---

### `stockLots/{lotId}`
> FIFO — 1 lot = 1 ครั้งที่รับสินค้าเข้า

```js
{
  id:              string,
  productId:       string,
  branchId:        string,
  receivingId:     string,       // อ้างอิง GRN
  costPerUnit:     number,       // ต้นทุนต่อหน่วยฐาน (ชิ้น)
  qtyReceived:     number,       // จำนวนที่รับเข้า (หน่วยฐาน)
  qtyRemaining:    number,       // คงเหลือในล็อตนี้
  receivedAt:      Timestamp,    // ใช้เรียงลำดับ FIFO
  expiryDate:      Timestamp | null,
  isDepleted:      boolean,      // true เมื่อ qtyRemaining === 0
  createdAt:       Timestamp,
}
```

---

### `stockMovements/{movId}`
> ทุกความเคลื่อนไหวของสต็อก (ขาย / รับเข้า / ปรับ / โอน)

```js
{
  id:           string,
  productId:    string,
  branchId:     string,
  type:         "sale" | "receive" | "adjust" | "transfer_in" | "transfer_out" | "void",
  qty:          number,          // + = เข้า, - = ออก (หน่วยฐาน)
  costPerUnit:  number,          // ต้นทุน FIFO ของล็อตที่ตัด
  refId:        string,          // orderId / receivingId / ฯลฯ
  refType:      string,          // "order" | "receiving" | "adjustment"
  note:         string,
  createdBy:    string,          // userId
  createdAt:    Timestamp,
}
```

---

### `customers/{customerId}`
```js
{
  id:           string,
  memberNo:     string,          // "MBR-00142"
  firstName:    string,
  lastName:     string,
  phone:        string,
  email:        string | null,
  taxId:        string | null,
  address:      string | null,
  priceLevelId: string,          // ระดับราคาของลูกค้านี้
  creditLimit:  number,          // วงเงินเชื่อ (0 = ไม่มีเครดิต)
  creditDays:   number,          // ระยะเวลาชำระ (วัน)
  totalSpent:   number,          // denormalized — อัปเดตทุกบิล
  points:       number,
  tags:         string[],
  note:         string,
  isActive:     boolean,
  createdAt:    Timestamp,
  updatedAt:    Timestamp,
  deletedAt:    Timestamp | null,
}
```

---

### `priceLevels/{priceLevelId}`
```js
{
  id:       string,
  name:     string,   // "ราคาปลีก"
  code:     string,   // "RETAIL"
  order:    number,   // ลำดับแสดงผล
  isActive: boolean,
}
```

---

### `uomUnits/{uomId}`
```js
{
  id:       string,
  name:     string,    // "กล่อง"
  code:     string,    // "BOX"
  baseUnit: string,    // "ชิ้น"
  factor:   number,    // 24
  isBase:   boolean,   // true เฉพาะ "ชิ้น"
  isActive: boolean,
}
```

---

### `orders/{orderId}`
> บิลขาย — Header

```js
{
  id:            string,         // "TW-0588"
  branchId:      string,
  customerId:    string | null,
  customerSnap:  {               // snapshot ตอนออกบิล
    name:     string,
    phone:    string,
    taxId:    string | null,
  } | null,
  staffId:       string,
  staffName:     string,         // denormalized
  status:        "completed" | "voided" | "pending_payment",
  subtotal:      number,         // ก่อนส่วนลด
  discountAmt:   number,         // ส่วนลดรายการรวม
  billDiscount:  number,         // ส่วนลดบิล
  vatRate:       number,         // 7 หรือ 0
  vatAmt:        number,
  surcharge:     number,         // ค่าธรรมเนียม
  total:         number,         // ยอดสุทธิ
  paidAmt:       number,
  changeAmt:     number,
  creditAmt:     number,         // ยอดที่ขอเชื่อ
  priceLevelId:  string,
  note:          string,
  voidReason:    string | null,
  voidedBy:      string | null,
  voidedAt:      Timestamp | null,
  printCount:    number,
  createdAt:     Timestamp,
  updatedAt:     Timestamp,
}
```

### `orders/{orderId}/orderItems/{itemId}`
> บิลขาย — รายการสินค้า (subcollection)

```js
{
  id:           string,
  productId:    string,
  productSnap:  {                // snapshot ตอนขาย
    name:     string,
    sku:      string,
    category: string,
  },
  unit:         string,          // "กล่อง"
  unitFactor:   number,          // 24
  qty:          number,          // จำนวน (หน่วยที่ขาย)
  qtyBase:      number,          // จำนวน × factor (หน่วยฐาน ตัดสต็อก)
  unitPrice:    number,          // ราคาต่อหน่วย
  discountAmt:  number,
  lineTotal:    number,          // (unitPrice × qty) - discount
  fifoCost:     number,          // ต้นทุน FIFO รวมของ line นี้
  lotRefs:      [                // ล็อตที่ถูกตัด (FIFO)
    { lotId: string, qty: number, cost: number }
  ],
}
```

---

### `payments/{paymentId}`
```js
{
  id:        string,
  orderId:   string,
  branchId:  string,
  method:    "cash" | "qr" | "kbank" | "card" | "credit",
  amount:    number,
  ref:       string | null,      // เลขอ้างอิง QR / บัตร
  createdAt: Timestamp,
}
```

---

### `quotations/{quotationId}`
```js
{
  id:           string,          // "QUO-202605-001"
  branchId:     string,
  customerId:   string | null,
  customerSnap: object | null,
  staffId:      string,
  status:       "draft" | "sent" | "accepted" | "rejected" | "expired",
  validUntil:   Timestamp,
  subtotal:     number,
  discountAmt:  number,
  vatAmt:       number,
  total:        number,
  note:         string,
  convertedToOrderId: string | null,
  createdAt:    Timestamp,
  updatedAt:    Timestamp,
}
```

### `quotations/{quotationId}/quotationItems/{itemId}`
> โครงสร้างเหมือน `orderItems` แต่ไม่มี `fifoCost` / `lotRefs`

---

### `receivings/{receivingId}`
> รับสินค้าเข้า (GRN)

```js
{
  id:           string,          // "GRN-202605-001"
  branchId:     string,
  supplierId:   string | null,
  supplierName: string,
  staffId:      string,
  status:       "draft" | "completed" | "cancelled",
  subtotal:     number,
  discountAmt:  number,
  vatRate:      number,
  vatAmt:       number,
  total:        number,
  payStatus:    "paid" | "pending" | "partial",
  paidAmt:      number,
  note:         string,
  receivedAt:   Timestamp,
  createdAt:    Timestamp,
  updatedAt:    Timestamp,
}
```

### `receivings/{receivingId}/receivingItems/{itemId}`
```js
{
  id:          string,
  productId:   string,
  productSnap: { name: string, sku: string },
  unit:        string,
  unitFactor:  number,
  qty:         number,
  qtyBase:     number,
  costPerUnit: number,           // ต้นทุนต่อหน่วยที่รับ
  costBase:    number,           // ต้นทุนต่อหน่วยฐาน
  lotId:       string,           // stockLot ที่สร้างใหม่
}
```

---

### `parkedOrders/{parkedId}`
> 💡 **Suspended / Parked Sales** — บิลที่พักไว้ชั่วคราว ยังไม่ใช่บิลจริง  
> ไม่ตัดสต็อก ไม่มีใน reports — ดึงกลับมาต่อได้ทุกเครื่องในสาขา

```js
{
  id:             string,          // "PARK-20260525-001"
  branchId:       string,
  deviceId:       string,          // เครื่องที่พักไว้
  parkedByUserId: string,
  parkedByName:   string,          // denormalized
  customerId:     string | null,
  customerSnap:   object | null,
  priceLevelId:   string,
  note:           string,          // "ลูกค้ารอของ / รอเจ้าของอนุมัติ / ฯลฯ"
  subtotal:       number,          // คำนวณ ณ ตอนพัก
  discountAmt:    number,
  total:          number,
  itemCount:      number,          // จำนวน line items (แสดงใน POS UI)
  status:         "parked" | "resumed" | "cancelled",
  parkedAt:       Timestamp,
  resumedAt:      Timestamp | null,
  resumedByUserId:string | null,
  expiresAt:      Timestamp,       // auto-expire เช่น 4 ชั่วโมง
}
```

### `parkedOrders/{parkedId}/parkedItems/{itemId}`
> โครงสร้างเหมือน `orderItems` แต่ไม่มี `fifoCost` / `lotRefs` (ยังไม่ตัดสต็อก)

```js
{
  id:           string,
  productId:    string,
  productSnap:  { name: string, sku: string, category: string },
  unit:         string,
  unitFactor:   number,
  qty:          number,
  qtyBase:      number,
  unitPrice:    number,
  discountAmt:  number,
  lineTotal:    number,
}
```

> ⚠️ **Transaction rules สำหรับ Parked Orders:**
> - `park` → write `parkedOrders` + items เท่านั้น — **ไม่แตะ** `stockLots` / `productStocks`
> - `resume` → โหลด items กลับเข้า POS cart state, update `status: "resumed"`
> - `confirm` → ผ่าน Payment flow ปกติ → สร้าง `orders` จริง + ตัดสต็อก FIFO atomic
> - `cancel` → update `status: "cancelled"` เท่านั้น
> - Auto-expire → Cloud Function ลบ parkedOrders ที่เกิน `expiresAt`

---

### Negative Inventory (สต็อกติดลบ)
> ⚙️ ควบคุมผ่าน `settings/{branchId}.allowNegativeStock`

**Logic ใน Create Order Transaction:**
```ts
const currentStock = productStockSnap.data()?.totalStockBase ?? 0;
const allowNeg = settingsSnap.data()?.allowNegativeStock ?? false;

if (currentStock < qtyBase) {
  if (!allowNeg) {
    throw new Error(`สต็อกไม่พอ: เหลือ ${currentStock} หน่วย`);
  }
  // อนุญาตให้ขายติดลบ — สร้าง "ghost lot" placeholder
  const ghostLotRef = doc(collection(db, 'stockLots'));
  tx.set(ghostLotRef, {
    productId, branchId,
    costPerUnit:  0,               // ยังไม่รู้ต้นทุน รอ Receiving
    qtyReceived:  0,
    qtyRemaining: currentStock - qtyBase,  // ค่าติดลบ
    receivedAt:   serverTimestamp(),
    isGhost:      true,            // flag รอ reconcile
    isDepleted:   false,
  });
}

// อัปเดต totalStockBase ปกติ (จะติดลบถ้าสต็อกไม่พอ)
tx.update(productStockRef, {
  totalStockBase: increment(-qtyBase),
});
```

**Reconcile ตอน Receiving เข้า (มี ghost lot):**
```ts
// หาก totalStockBase < 0 ก่อน receive → ส่วนแรกถือว่าชดใช้ ghost lot
// คำนวณ avgCost ใหม่จาก cost จริงที่รับเข้า
// update ghost lot ให้ costPerUnit = costBase และ isGhost = false
```

**ผลกระทบที่ต้องระวัง:**
- รายงานกำไร: สินค้าที่ขายจาก ghost lot จะแสดง COGS = 0 จนกว่าจะ reconcile
- แนะนำ: แสดง warning badge ในรายงานกำไรสำหรับ order ที่มี ghost lot

**เพิ่มใน `settings/{branchId}`:**
```js
allowNegativeStock: boolean,     // default: false
negativeStockWarning: boolean,   // แจ้งเตือนพนักงานก่อนขาย (แม้ allow)
```

---
> 1 ลูกค้า = 1 document (ใช้ customerId เป็น key)

```js
{
  customerId:     string,
  branchId:       string,
  creditLimit:    number,
  creditUsed:     number,        // denormalized — อัปเดตทุก transaction
  creditBalance:  number,        // creditLimit - creditUsed
  overdueAmt:     number,
  lastTransAt:    Timestamp | null,
  updatedAt:      Timestamp,
}
```

### `creditTransactions/{txId}`
```js
{
  id:          string,
  customerId:  string,
  branchId:    string,
  type:        "charge" | "payment" | "adjust",
  amount:      number,
  balance:     number,           // balance หลัง transaction
  refOrderId:  string | null,
  note:        string,
  createdBy:   string,
  createdAt:   Timestamp,
  dueDate:     Timestamp | null,
  isPaid:      boolean,
  paidAt:      Timestamp | null,
}
```

---

### `settings/{branchId}`
> 1 document ต่อสาขา

```js
{
  branchId:       string,
  vatRegistered:  boolean,
  vatRate:        number,        // 7
  priceIncludesVat: boolean,
  paymentMethods: {              // เปิด/ปิดต่อสาขา
    cash:   boolean,
    qr:     boolean,
    kbank:  boolean,
    card:   boolean,
    credit: boolean,
  },
  receiptHeader:  string,
  receiptFooter:  string,
  receiptLogoUrl: string | null,
  showBarcodeOnReceipt: boolean,
  showQrOnReceipt:      boolean,
  pinMaxAttempts:       number,
  sessionTimeoutMin:    number,
  notifications: {
    lowStock:     { line: boolean, email: boolean },
    voidOrder:    { line: boolean, email: boolean },
    overCredit:   { line: boolean, email: boolean },
    dailySummary: { line: boolean, email: boolean },
  },
  lineNotifyToken: string | null,
  // ข้อ 1 — Negative Stock
  allowNegativeStock:   boolean,   // default: false
  negativeStockWarning: boolean,   // แจ้งเตือนก่อนขาย (แม้ allow)
  // ข้อ 2 — Parked Orders
  parkedOrderExpiryHours: number,  // auto-expire (default: 4)
  updatedAt:       Timestamp,
}
```

---

### `posDevices/{deviceId}`
```js
{
  id:         string,
  branchId:   string,
  name:       string,            // "POS-01"
  type:       "desktop" | "tablet" | "mobile",
  token:      string,            // device token สำหรับ auth
  isOnline:   boolean,
  lastSeenAt: Timestamp | null,
  currentUserId: string | null,
  createdAt:  Timestamp,
}
```

---

### `staffActivities/{activityId}`
```js
{
  id:        string,
  branchId:  string,
  userId:    string,
  userName:  string,
  action:    string,             // "LOGIN" | "VOID_ORDER" | "EDIT_PRICE" | ...
  detail:    string,             // รายละเอียด
  refId:     string | null,      // orderId / productId ที่เกี่ยวข้อง
  ip:        string | null,
  deviceId:  string | null,
  createdAt: Timestamp,
}
```

---

### `auditLogs/{logId}`
> ⚡ **ใช้เฉพาะ action ที่ Sensitive จริงๆ** — ไม่บันทึกทุก write เพื่อคุม Firestore storage cost

**Collections ที่บันทึกเข้า auditLogs:**
- `orders` — เฉพาะ void / refund (ไม่บันทึก create ปกติ — มี order document เป็น audit อยู่แล้ว)
- `products` — แก้ราคา (`prices`) หรือ ลบ
- `stockMovements` — เฉพาะ type `"adjust"` (ปรับสต็อกมือ) ไม่บันทึก sale/receive ปกติ
- `users` — เปลี่ยน role / permissions / ลบ
- `settings` — แก้ VAT, payment methods, security policy
- `creditAccounts` — เพิ่ม/ลดวงเงิน manually (ไม่บันทึก charge/payment ปกติ — มี creditTransactions เป็น log อยู่แล้ว)

**Collections ที่ NOT บันทึก** (มี log ของตัวเองอยู่แล้ว):
- `stockMovements` ทั่วไป — เป็น log อยู่แล้ว
- `creditTransactions` — เป็น log อยู่แล้ว
- `staffActivities` — เป็น log อยู่แล้ว
- `payments` — append-only

```js
{
  id:         string,
  collection: string,            // "orders" | "products" | ...
  docId:      string,
  action:     "create" | "update" | "delete" | "void" | "refund",
  before:     object | null,     // snapshot ก่อนแก้ (เฉพาะ field ที่เปลี่ยน)
  after:      object | null,     // snapshot หลังแก้ (เฉพาะ field ที่เปลี่ยน)
  changedFields: string[],       // ["price", "discount"] — รู้ว่า field ไหนเปลี่ยน
  reason:     string | null,     // เหตุผล (เช่น void reason)
  changedBy:  string,            // userId
  changedByName: string,         // denormalized
  changedAt:  Timestamp,
}
```

> 💡 **เก็บแค่ field ที่เปลี่ยน** ไม่ใช่ทั้ง document → ลด storage cost ลง 70-90%

---

## 🔐 Firestore Security Rules (โครงสร้าง)

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper functions
    function isAuth() { return request.auth != null; }
    function isAdmin() { return get(/users/$(request.auth.uid)).data.role == 'admin'; }
    function isManager() { return get(/users/$(request.auth.uid)).data.role in ['admin','manager']; }
    function hasBranchAccess(branchId) {
      return branchId in get(/users/$(request.auth.uid)).data.branchIds;
    }

    // Products — อ่านได้ทุกคนที่ login, เขียนได้ Manager ขึ้นไป
    match /products/{id} {
      allow read:  if isAuth();
      allow write: if isManager();
    }

    // Orders — อ่าน/สร้างได้ทุกคนในสาขา, void ได้ Manager ขึ้นไป
    match /orders/{id} {
      allow read:   if isAuth() && hasBranchAccess(resource.data.branchId);
      allow create: if isAuth() && hasBranchAccess(request.resource.data.branchId);
      allow update: if isManager() && hasBranchAccess(resource.data.branchId);
    }

    // Settings — อ่านได้ทุกคน, แก้ได้ Admin เท่านั้น
    match /settings/{branchId} {
      allow read:  if isAuth() && hasBranchAccess(branchId);
      allow write: if isAdmin() && hasBranchAccess(branchId);
    }

    // Users — Admin จัดการได้, ตัวเองอ่านได้
    match /users/{userId} {
      allow read:  if isAuth() && (request.auth.uid == userId || isAdmin());
      allow write: if isAdmin();
    }
  }
}
```

---

## ⚛️ Atomic Operations (สำคัญมาก!)

> ⚠️ **ทุก stock-related write ต้องเป็น Firestore Transaction**  
> หากใช้ batch write ปกติ จะเกิด race condition เมื่อมีหลายคนขายพร้อมกัน

### 🛒 Create Order (ขายสินค้า)

```ts
await runTransaction(db, async (tx) => {
  // 1. READ phase — ต้องอ่านทั้งหมดก่อน write
  const productStockRef = doc(db, `products/${productId}/productStocks/${branchId}`);
  const productStockSnap = await tx.get(productStockRef);
  const currentStock = productStockSnap.data()?.totalStockBase ?? 0;

  // ตรวจสต็อกพอไหม
  if (currentStock < qtyBase) {
    throw new Error(`สต็อกไม่พอ: เหลือ ${currentStock} ต้องการ ${qtyBase}`);
  }

  // อ่าน FIFO lots
  const lotsQuery = query(
    collection(db, 'stockLots'),
    where('productId', '==', productId),
    where('branchId', '==', branchId),
    where('isDepleted', '==', false),
    orderBy('receivedAt', 'asc')
  );
  const lotsSnap = await getDocs(lotsQuery);  // ใช้ getDocs ก่อน tx (read-only)

  // 2. CALCULATE phase — คำนวณการตัด FIFO
  let remaining = qtyBase;
  const lotRefs: LotRef[] = [];
  const lotUpdates: Array<{ ref: DocRef; newQty: number }> = [];

  for (const lotDoc of lotsSnap.docs) {
    if (remaining <= 0) break;
    const lot = lotDoc.data();
    const cut = Math.min(remaining, lot.qtyRemaining);
    lotRefs.push({ lotId: lotDoc.id, qty: cut, cost: lot.costPerUnit });
    lotUpdates.push({
      ref: lotDoc.ref,
      newQty: lot.qtyRemaining - cut,
    });
    remaining -= cut;
  }

  // 3. WRITE phase — atomic write ทั้งหมด
  const orderRef = doc(collection(db, 'orders'));
  tx.set(orderRef, { /* order data */ });

  // 3a. ตัด stockLots
  for (const { ref, newQty } of lotUpdates) {
    tx.update(ref, {
      qtyRemaining: newQty,
      isDepleted: newQty === 0,
    });
  }

  // 3b. ⚡ อัปเดต denormalized stock total
  tx.update(productStockRef, {
    totalStockBase: increment(-qtyBase),
    lastMovementAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 3c. บันทึก stockMovement
  const movRef = doc(collection(db, 'stockMovements'));
  tx.set(movRef, {
    productId, branchId,
    type: 'sale',
    qty: -qtyBase,
    refId: orderRef.id,
    refType: 'order',
    createdAt: serverTimestamp(),
  });

  // 3d. ถ้าเชื่อ — อัปเดต creditAccount
  if (creditAmt > 0) {
    const credRef = doc(db, `creditAccounts/${customerId}`);
    tx.update(credRef, {
      creditUsed: increment(creditAmt),
      lastTransAt: serverTimestamp(),
    });
  }
});
```

### 📦 Receiving (รับสินค้าเข้า)

```ts
await runTransaction(db, async (tx) => {
  // 1. สร้าง stockLot ใหม่
  const lotRef = doc(collection(db, 'stockLots'));
  tx.set(lotRef, {
    productId, branchId,
    qtyReceived: qtyBase,
    qtyRemaining: qtyBase,
    costPerUnit: costBase,
    receivedAt: serverTimestamp(),
    isDepleted: false,
  });

  // 2. ⚡ อัปเดต denormalized stock total
  const productStockRef = doc(db, `products/${productId}/productStocks/${branchId}`);
  tx.set(productStockRef, {
    branchId,
    totalStockBase: increment(qtyBase),
    lastMovementAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }, { merge: true });

  // 3. บันทึก stockMovement
  tx.set(doc(collection(db, 'stockMovements')), {
    productId, branchId,
    type: 'receive',
    qty: qtyBase,
    costPerUnit: costBase,
    refId: receivingId,
    refType: 'receiving',
  });

  // 4. คำนวณ avgCost ใหม่ (optional - update ที่ products)
  // อ่าน lots ที่เหลือทั้งหมดแล้วคำนวณ weighted average
});
```

### 🚫 Void Order (ยกเลิกบิล)

```ts
await runTransaction(db, async (tx) => {
  const orderRef = doc(db, `orders/${orderId}`);
  const orderSnap = await tx.get(orderRef);
  const items = await getDocs(collection(orderRef, 'orderItems'));

  // 1. คืนสต็อกเข้า lots เดิม (reverse FIFO refs)
  for (const itemDoc of items.docs) {
    const item = itemDoc.data();
    for (const lotRef of item.lotRefs) {
      const lotDocRef = doc(db, `stockLots/${lotRef.lotId}`);
      tx.update(lotDocRef, {
        qtyRemaining: increment(lotRef.qty),
        isDepleted: false,
      });
    }
    // ⚡ คืนค่า denormalized stock
    tx.update(
      doc(db, `products/${item.productId}/productStocks/${item.branchId}`),
      { totalStockBase: increment(item.qtyBase) }
    );
    // log movement
    tx.set(doc(collection(db, 'stockMovements')), {
      productId: item.productId,
      branchId: item.branchId,
      type: 'void',
      qty: item.qtyBase,
      refId: orderId,
    });
  }

  // 2. Update order status
  tx.update(orderRef, {
    status: 'voided',
    voidReason,
    voidedBy: userId,
    voidedAt: serverTimestamp(),
  });

  // 3. คืนเครดิตถ้ามี
  if (orderSnap.data().creditAmt > 0) {
    tx.update(doc(db, `creditAccounts/${orderSnap.data().customerId}`), {
      creditUsed: increment(-orderSnap.data().creditAmt),
    });
  }

  // 4. บันทึก audit log (action sensitive)
  tx.set(doc(collection(db, 'auditLogs')), {
    collection: 'orders',
    docId: orderId,
    action: 'void',
    reason: voidReason,
    changedBy: userId,
    changedAt: serverTimestamp(),
  });
});
```

### ⚠️ ข้อควรระวัง Transaction

| ❌ ผิด | ✅ ถูก |
|--------|--------|
| `await tx.get()` หลัง `tx.set()` | อ่านก่อน write เสมอ (read phase first) |
| ใช้ `where()` ภายใน transaction | Query ก่อนเข้า transaction แล้วส่ง refs เข้าไป |
| Transaction นาน > 5 วินาที | ทำให้สั้น atomic operations เท่านั้น |
| อัปเดต `stockLots` แต่ลืม `productStocks` | ⚡ ต้องอัปเดตคู่กันเสมอ |

---

## ⚡ Indexes ที่ควรสร้าง

| Collection | Fields | ใช้สำหรับ |
|-----------|--------|----------|
| `orders` | `branchId` ASC, `createdAt` DESC | รายงานยอดขาย |
| `orders` | `branchId` ASC, `status` ASC, `createdAt` DESC | filter สถานะ |
| `orders` | `customerId` ASC, `createdAt` DESC | ประวัติลูกค้า |
| `stockLots` | `productId` ASC, `branchId` ASC, `isDepleted` ASC, `receivedAt` ASC | FIFO queue |
| `stockMovements` | `productId` ASC, `branchId` ASC, `createdAt` DESC | stock history |
| `creditTransactions` | `customerId` ASC, `isPaid` ASC, `dueDate` ASC | หนี้ค้าง |
| `staffActivities` | `branchId` ASC, `createdAt` DESC | activity log |
| `products` | `category` ASC, `isActive` ASC, `name` ASC | filter หมวด + ค้นหา |
| `products` | `prices` (array-contains-any) | query สินค้าตาม priceLevel/unit |

---

## 📊 ความสัมพันธ์ (Relationship Map)

```
branches ──┬── users (branchIds[])
           ├── products
           │   └── productStocks (sub, per branch)
           ├── stockLots ──── stockMovements
           ├── orders ──────── orderItems (sub)
           │              └── payments
           ├── parkedOrders ── parkedItems (sub)   ← ยังไม่ตัดสต็อก
           ├── receivings ──── receivingItems (sub)
           │              └── stockLots (สร้างใหม่)
           ├── customers ───── creditAccounts
           │              └── creditTransactions
           ├── quotations ──── quotationItems (sub)
           ├── settings ───── (allowNegativeStock, parkedExpiry)
           ├── posDevices
           └── staffActivities
```

---

## 💡 Tips สำหรับ Cursor

เมื่อเริ่ม implement ใน Cursor บอกว่า:
> "ใช้ Firestore schema นี้ สร้าง TypeScript types และ Firebase hooks สำหรับ [collection ที่ต้องการ]"

แนะนำ library เพิ่มเติม:
- `firebase` — Firestore SDK
- `react-firebase-hooks` — hooks สำเร็จรูป
- `zod` — validate data ก่อน write
