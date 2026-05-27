# TwinPet POS — คู่มือส่งต่อ Cursor
> เวอร์ชัน: พฤษภาคม 2569 · เตรียมโดย Claude

---

## 📁 ไฟล์ทั้งหมดในโปรเจกต์

### HTML Reference (UI ที่ออกแบบแล้ว)
| ไฟล์ | หน้า |
|------|------|
| `twinpet_pos_v2.html` | POS หลัก (กริดสินค้า + ตะกร้า + UOM) |
| `twinpet_customer_modal.html` | Modal ลูกค้า / สมาชิก 5 tabs |
| `twinpet_product_crud_v2.html` | จัดการสินค้า CRUD + FIFO Batch Modal |
| `twinpet_sales_history.html` | ประวัติการขาย + Drawer + Void |
| `twinpet-login.html` | Login (Quick PIN / Username) |
| `twinpet-dashboard.html` | Dashboard ภาพรวม + ช่องทางชำระเงิน |
| `twinpet-stock-report.html` | รายงานสต็อก 4 Tabs + FIFO Queue |
| `twinpet-profit-report.html` | รายงานกำไร + Group By + Sort + Pagination |
| `twinpet-staff-management.html` | จัดการพนักงาน + Permission Matrix |
| `twinpet-export-report.html` | Export Excel UI (SheetJS) |
| `twinpet-settings.html` | Settings 9 sections ครบ |
| `twinpet-invoice-a4.html` | ใบเสร็จ A4 / Invoice 5 ประเภท |
| `twinpet-receipt-thermal.html` | Thermal 80mm + ใบจัดของ |

### เอกสาร
| ไฟล์ | เนื้อหา |
|------|---------|
| `twinpet_project_summary.md` | สรุป Design System + Business Logic ทั้งหมด |
| `twinpet_firestore_schema.md` | Firestore Schema ครบ 16 collections |
| `twinpet_daily_report.xlsx` | ตัวอย่าง Excel สรุปยอดรายวัน 8 sheets |

---

## 🚀 เริ่มต้นโปรเจกต์ใน Cursor

### ขั้นตอนที่ 1 — สร้างโปรเจกต์

```bash
npm create vite@latest twinpet-pos -- --template react-ts
cd twinpet-pos
npm install
npm install firebase react-firebase-hooks react-router-dom
npm install lucide-react @tanstack/react-query zod
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

### ขั้นตอนที่ 2 — โครงสร้าง Folder

```
twinpet-pos/
├── reference/              ← วาง HTML ทั้งหมดไว้ที่นี่
│   ├── twinpet_pos_v2.html
│   ├── twinpet-dashboard.html
│   └── ... (ทุกไฟล์)
├── docs/
│   ├── twinpet_project_summary.md
│   ├── twinpet_firestore_schema.md
│   └── twinpet_cursor_guide.md  ← ไฟล์นี้
├── src/
│   ├── components/
│   ├── pages/
│   ├── hooks/
│   ├── lib/
│   │   ├── firebase.ts
│   │   └── types.ts
│   └── styles/
│       └── variables.css    ← CSS vars จาก design system
└── ...
```

### ขั้นตอนที่ 3 — วาง CSS Variables

สร้างไฟล์ `src/styles/variables.css`:

```css
:root {
  --p600: #534AB7;
  --p500: #6B62C9;
  --p400: #7F77DD;
  --p100: #CECBF6;
  --p50:  #EEEDFE;
  --g50:  #F8F8FC;
  --g100: #EDEDF5;
  --success:    #0F6E56;
  --success-bg: #E1F5EE;
  --danger:     #A32D2D;
  --danger-bg:  #FCEBEB;
  --warn:       #854F0B;
  --warn-bg:    #FAEEDA;
  --info:       #185FA5;
  --info-bg:    #E6F1FB;
  --border:     rgba(0,0,0,0.08);
  --border-md:  rgba(0,0,0,0.13);
  --text-primary:   #1A1A2E;
  --text-secondary: #6B7280;
  --text-muted:     #9CA3AF;
}
```

---

## 💬 Prompt สำหรับ Cursor

> คัดลอก prompt ด้านล่างไปวางใน Cursor Chat ได้เลย

---

### 🟣 Prompt ที่ 1 — เริ่มต้นโปรเจกต์ (ใช้ก่อนเลย)

```
ผมกำลังพัฒนา TwinPet POS System สำหรับร้านขายสัตว์เลี้ยง 2-3 สาขา

โปรเจกต์มีไฟล์ reference HTML ครบทุกหน้าอยู่ใน /reference/
และมี Firestore schema ใน /docs/twinpet_firestore_schema.md
และ Design System ใน /docs/twinpet_project_summary.md

Tech Stack:
- React + TypeScript + Vite
- Firebase (Firestore + Auth)
- Tabler Icons
- Font: Prompt (ตัวเลข/heading) + Sarabun (body)
- CSS Variables จาก src/styles/variables.css

Design System สำคัญ:
- Primary: --p600: #534AB7
- Layout pattern: Topbar sticky (← ชื่อ | badge | ยกเลิก + บันทึก) + Footer summary ตัวเลข
- Branch badge: read-only ไม่มี chevron
- FIFO Costing: ตัดสต็อก backend FIFO, แสดง Average Cost ให้พนักงาน

ขั้นตอนแรก: สร้าง TypeScript types ทั้งหมดจาก Firestore schema ใน /docs/twinpet_firestore_schema.md
วางไว้ที่ src/lib/types.ts
```

---

### 🟣 Prompt ที่ 2 — Firebase Setup

```
สร้าง Firebase configuration และ utility hooks สำหรับ TwinPet POS

1. src/lib/firebase.ts — initialize Firebase app
2. src/lib/hooks/useAuth.ts — login ด้วย custom PIN และ username/password
3. src/lib/hooks/useBranch.ts — จัดการ current branch จาก user.branchIds
4. src/lib/hooks/useFirestore.ts — generic CRUD hooks

อ้างอิง types จาก src/lib/types.ts และ schema จาก /docs/twinpet_firestore_schema.md

PIN login flow: 
- รับ PIN 4 หลัก → query users ที่มี branchId ตรง → compare bcrypt hash → set session
```

---

### 🟣 Prompt ที่ 3 — แปลงหน้า Login

```
แปลง /reference/twinpet-login.html เป็น React component

Output: src/pages/LoginPage.tsx

Requirements:
- Default mode = Quick PIN (ไม่แสดงชื่อพนักงาน จนกว่าจะกด PIN ถูก)
- Username/Password tab สำหรับ fallback
- Branch selector dropdown
- Mock accounts ใน dev mode:
  somchai/admin1234/PIN:1234, suda/manager01/PIN:2345
  wichai/staff001/PIN:3456, nongnuch/staff002/PIN:4567
- Success overlay แสดงชื่อ + Role + สาขา
- เชื่อม useAuth hook จาก src/lib/hooks/useAuth.ts
- คง CSS variables และ design เดิมทุกอย่าง
```

---

### 🟣 Prompt ที่ 4 — แปลงหน้า Dashboard

```
แปลง /reference/twinpet-dashboard.html เป็น React component

Output: src/pages/DashboardPage.tsx

Requirements:
- Period tabs: วันนี้ / สัปดาห์นี้ / เดือนนี้
- KPI cards 4 ใบ เปรียบเทียบ % vs ช่วงก่อน
- Bar chart (Chart.js) ยอดขาย vs กำไร รายชั่วโมง/รายวัน
- Donut chart แยกตามหมวดหมู่
- Top 5 สินค้า, Top 5 ลูกค้า
- ช่องทางชำระเงิน 5 ช่อง (cash/qr/kbank/card/credit) — horizontal scroll เมื่อ >4
- Stock alerts
- ดึงข้อมูลจาก Firestore: orders, stockLots
- ใช้ useMemo สำหรับ aggregation
```

---

### 🟣 Prompt ที่ 5 — แปลงหน้า POS หลัก

```
แปลง /reference/twinpet_pos_v2.html เป็น React component

Output: src/pages/POSPage.tsx

Requirements:
- Product grid 6 columns + Category filter bar
- Cart panel ด้านขวา
- UOM flow: คลิกสินค้า → popup เลือกหน่วยถ้ามีหลายหน่วย → เข้าตะกร้าทันทีถ้าหน่วยเดียว
- Item discount popup: ลด ฿ / ลด % / แก้ราคา
- ปุ่ม "+ เลือกสินค้า" เรียก ProductPickerDialog
- Cart footer: ส่วนลด + ค่าธรรมเนียม + grand total + ปุ่มชำระเงิน
- เรียก PaymentModal เมื่อกดชำระเงิน
- FIFO stock cut ผ่าน Firebase Transaction (atomic)
- ดึง products จาก Firestore realtime listener
```

---

### 🟣 Prompt ที่ 6 — Modal ชำระเงิน

```
สร้าง PaymentModal component สำหรับ TwinPet POS

Output: src/components/PaymentModal.tsx

5 ช่องทาง (อ้างอิงจาก settings.paymentMethods ของสาขา):
- cash (ti-cash): numpad + quick bills สะสม (100+500=600)
- qr (ti-qrcode): PromptPay QR placeholder
- kbank (ti-building-bank): KBank QR placeholder  
- card (ti-credit-card): EDC
- credit (ti-clock-dollar): ชำระบางส่วน + บันทึกหนี้ค้าง

Layout: Sidebar 86px | Main flex:1 | Summary panel 185px
Multi-payment: สะสมได้, auto-fill remaining, paid-dot บน sidebar
Summary: ขาดอีก/ครบ/ทอน real-time
Confirm: active เมื่อครบหรือมีเชื่อ

เมื่อ confirm:
1. สร้าง order document
2. สร้าง orderItems subcollection
3. ตัด stockLots แบบ FIFO ด้วย Firestore Transaction
4. สร้าง stockMovements
5. อัปเดต creditAccount ถ้ามีเชื่อ
```

---

### 🟣 Prompt ที่ 7 — FIFO Stock Cut Logic

```
สร้าง utility function สำหรับ FIFO stock cut

Output: src/lib/fifo.ts

function cutStockFIFO(
  productId: string,
  branchId: string,
  qtyNeeded: number,  // หน่วยฐาน (ชิ้น)
  transaction: FirebaseFirestore.Transaction
): Promise<LotRef[]>

Logic:
1. Query stockLots where productId=X, branchId=Y, isDepleted=false order by receivedAt ASC
2. ตัดทีละ lot จากเก่าสุด
3. อัปเดต qtyRemaining ของแต่ละ lot
4. Set isDepleted=true เมื่อ qtyRemaining===0
5. Return lotRefs[] สำหรับเก็บใน orderItems

ต้องทำใน Firestore Transaction เพื่อ atomic ป้องกัน race condition
```

---

### 🟣 Prompt ที่ 8 — รายงานกำไร

```
แปลง /reference/twinpet-profit-report.html เป็น React component

Output: src/pages/ProfitReportPage.tsx

Requirements:
- Date picker + 7 preset chips
- Group By dropdown: รายบิล / หมวดหมู่ / สินค้า / ลูกค้า
- Sortable table headers (click ▲▼)
- Pagination 10 rows/page
- KPI cards + Bar chart + Donut chart คำนวณจาก full dataset (ไม่ใช่แค่หน้าปัจจุบัน)
- Product picker modal
- Export CSV
- Query: orders + orderItems จาก Firestore กรองตาม branchId + date range
```

---

### 🟣 Prompt ที่ 9 — Settings

```
แปลง /reference/twinpet-settings.html เป็น React component

Output: src/pages/SettingsPage.tsx

9 sections (sidebar nav):
1. ข้อมูลสาขา — ชื่อ ที่อยู่ โลโก้ (upload to Firebase Storage)
2. VAT & ภาษี — toggle จด/ไม่จด, อัตรา
3. ระดับราคา — CRUD drag-and-drop
4. UOM — CRUD หน่วยนับ + ค่าแปลง
5. ช่องทางชำระเงิน — toggle 5 ช่อง + วงเงินเชื่อ
6. ใบเสร็จ — header/footer text + logo upload + thermal preview
7. การแจ้งเตือน — 6 events × 4 channels + LINE token
8. เครื่อง POS — device list + force logout
9. Admin — PIN policy + backup + Danger Zone

อ่านจาก settings/{branchId} และ save กลับ Firestore
```

---

### 🟣 Prompt ที่ 10 — Routing & App Shell

```
สร้าง App Shell และ Routing สำหรับ TwinPet POS

Output: src/App.tsx, src/components/AppShell.tsx

Routes:
- /login → LoginPage (ไม่ต้อง auth)
- / → redirect to /dashboard
- /dashboard → DashboardPage
- /pos → POSPage
- /products → ProductCRUDPage
- /receiving → ReceivingPage
- /sales-history → SalesHistoryPage
- /customers → CustomerPage
- /stock-report → StockReportPage
- /profit-report → ProfitReportPage
- /staff → StaffManagementPage
- /export → ExportReportPage
- /settings → SettingsPage

AppShell: Sidebar nav 52px icon-only (expand on hover) + top branch badge
Protected routes: redirect /login ถ้ายังไม่ login
Branch check: ถ้า user ไม่มีสิทธิ์สาขาที่เลือก → redirect /login
```

---

## 🗺️ ลำดับการพัฒนาแนะนำ

```
Phase 1 — Foundation
  ✅ Types + Firebase setup
  ✅ Auth (PIN + Username)
  ✅ App Shell + Routing

Phase 2 — Core POS
  ✅ POS หลัก + Payment Modal
  ✅ FIFO Stock Cut
  ✅ Product CRUD

Phase 3 — Reports
  ✅ Dashboard
  ✅ Sales History
  ✅ Stock Report
  ✅ Profit Report

Phase 4 — Management
  ✅ Staff Management
  ✅ Customer / Credit
  ✅ Settings

Phase 5 — Documents
  ✅ Thermal Receipt
  ✅ A4 Invoice
  ✅ Export Excel
```

---

## ⚙️ Environment Variables

สร้างไฟล์ `.env.local`:
```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

---

## 📌 Business Rules สำคัญ (บอก Cursor ทุกครั้ง)

- **สต็อก**: เก็บเป็นหน่วยฐาน (ชิ้น) เสมอ, แปลง UOM ก่อน write
- **FIFO**: ตัดสต็อก backend FIFO จาก `stockLots` เรียงตาม `receivedAt` ASC
- **Average Cost**: แสดงให้พนักงานเห็น (คำนวณจาก lots ที่เหลือ)
- **VAT**: ตั้งต่อสาขา, ถ้าไม่จด VAT → ซ่อน option ใบกำกับภาษีทั้งหมด
- **Branch badge**: read-only เสมอ ไม่มี chevron/dropdown
- **Topbar pattern**: ← ชื่อหน้า | badge | ยกเลิก + บันทึก (มุมขวาบน)
- **Footer pattern**: summary ตัวเลขอย่างเดียว — ไม่มีปุ่ม action
- **⚡ Parked Orders**: ใช้ `parkedOrders` collection — **ไม่ตัดสต็อก** ตอนพัก, ตัดสต็อกเฉพาะตอน confirm จริงผ่าน Payment flow เท่านั้น
- **⚡ Negative Stock**: ควบคุมด้วย `settings.allowNegativeStock` — ถ้า allow ให้สร้าง ghost lot (`isGhost: true, costPerUnit: 0`) และ reconcile ตอน Receiving
- **⚡ Atomic Stock Operations**: ทุก stock write (`stockLots` + `productStocks` + `stockMovements`) ต้องอยู่ใน **Firestore Transaction เดียวกัน** — ดู pseudocode ใน schema.md → "Atomic Operations"
- **⚡ Stock Display**: หน้า POS ต้องอ่าน `totalStockBase` จาก `products/{id}/productStocks/{branchId}` เท่านั้น **ห้าม sum จาก stockLots** (N+1 query)
- **Selective Audit**: บันทึก `auditLogs` เฉพาะ void/refund/edit price/edit role/edit settings เท่านั้น
- **Soft delete**: ใช้ `deletedAt` ไม่ลบจริง
- **Snapshot**: copy ชื่อสินค้า/ราคา/ชื่อลูกค้าลงใน order ตอนสร้าง ป้องกันข้อมูลเปลี่ยนย้อนหลัง
