# TwinPet POS System — Project Summary
สำหรับใช้เริ่มต้น conversation ใหม่

---

## 🎨 Design System

### CSS Variables
```css
--p50:#EEEDFE;  --p100:#CECBF6; --p200:#AFA9EC; --p400:#7F77DD;
--p600:#534AB7; --p800:#3C3489; --p900:#26215C;
--g50:#F8F8FC;  --g100:#F1EFE8; --g200:#D3D1C7; --g400:#888780; --g600:#5F5E5A;
--green:#1D9E75; --teal50:#E1F5EE; --amber:#BA7517; --amber50:#FAEEDA; --red:#E24B4A;
```

### Fonts
- **Prompt** — ตัวเลข, heading, font-weight 400/500/600
- **Sarabun** — body, label, button

### Layout Pattern ทุกหน้า
- **Topbar (sticky top):** ← ชื่อหน้า | badge | `[ยกเลิก]` `[บันทึก]` มุมขวาบนเสมอ
- **Footer (sticky bottom):** summary ตัวเลขอย่างเดียว — ไม่มีปุ่ม action

### Design Rules
- สาขา: **read-only badge** จาก login account — ไม่มี chevron/dropdown
- VAT toggles: **fix height** แสดงตลอด — label คงอยู่ เปลี่ยนแค่สี ไม่ซ่อน/แสดง
- Toggle 2 (ราคารวมภาษีแล้ว): ล็อค disabled จนกว่า Toggle 1 จะเปิด
- Footer สัดส่วน: ทุก section **flex:1** เท่ากัน, totals fixed width ชิดขวา
- Tabler Icons: `https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css`

---

## ✅ หน้าที่เสร็จแล้ว (พร้อม HTML file)

### 1. หน้า POS หลัก v2 (`twinpet_pos_v2.html`)
- Sidebar nav (52px) + Topbar + Category bar + Product grid 6 คอล + Cart ขวา
- **Branch badge:** read-only ไม่มี chevron
- **ปุ่ม "+ เลือกสินค้า":** ต่อท้าย search bar → เรียก Dialog
- **UOM Flow:** คลิก product → popup เลือกหน่วยถ้ามีหลายหน่วย → ลงตะกร้าทันทีถ้าหน่วยเดียว
- **Cart item price:** คลิกได้ → Item Discount Popup (ลด ฿ / ลด % / แก้ราคา)
- **Category buttons:** bg image + dark overlay + fallback color
- Cart footer: ส่วนลด (฿/%) + ค่าธรรมเนียม chip + grand total + ปุ่มชำระเงิน

### 2. Modal ชำระเงิน (twinpet_payment_v3b — widget เท่านั้น ยังไม่มี HTML file)
**Layout:** Sidebar 86px | Main flex:1 | Summary 185px
- 5 ช่องทาง: เงินสด (numpad+quick bills) / PromptPay QR / KBank QR / EDC / เชื่อ
- **Multi-payment:** สะสม, auto-fill remaining, paid-dot บน sidebar
- **เงินสด:** quick bills สะสม (100+500=600), numpad พื้น --g50 ตัวเลข --p900
- **เชื่อ:** ชำระบางส่วน + บันทึกหนี้ค้างชำระ
- **Summary panel:** ขาดอีก/ครบ/ทอน real-time, confirm btn active เมื่อครบหรือมีเชื่อ

### 3. หน้าจัดการสินค้า v2 (`twinpet_product_crud_v2.html`)
- Filter bar: search flex:1 + scan badge + custom dropdown หมวด 90px + stock chips
- Barcode scan → jump to row + flash + เปิด drawer
- Pagination dropdown 50/100/200
- Drawer 3 tab: ข้อมูลสินค้า / สต็อก / ประวัติ
- **ต้นทุน FIFO:** สินค้าใหม่กรอกได้, สินค้าเก่า read-only Avg Cost + ปุ่ม "📦 ดูคิวล็อต"
- **FIFO Batch Modal:** summary bar + ตาราง queue แก้ต้นทุนต่อ lot + lot status badge + depleted เทา
- UOM section (แบบ B พับได้): หน่วยฐาน + หน่วยย่อย + ราคาต่อระดับ
- สต็อก tab: ปรับสาขาตัวเอง, ดูสาขาอื่น read-only

### 4. หน้ารับสินค้าเข้า (`twinpet_receiving_v6.html` — อยู่ใน widget)
- Full-page scroll (ไม่ fixed height)
- Card ข้อมูลเบื้องต้น + Card รายการสินค้า
- Topbar sticky: ← ชื่อหน้า | GRN badge | ยกเลิก + บันทึก มุมขวาบน
- Scan bar + ปุ่ม "+ เพิ่มสินค้า" → Dialog เลือกสินค้า + Import Excel
- Footer sticky: ส่วนลด + VAT toggles (2 อัน fix height) + totals — ไม่มีปุ่ม
- Payment status: เลือกหลังกด "บันทึก" → modal ชำระแล้ว/ค้างชำระ

### 5. Dialog เลือกสินค้า — Shared Component (widget)
- Search: label | dropdown 90px (CSS grid) | input 1fr | ค้นหา | รีเซต
- Table style + checkbox + เลือกทั้งหมด (indeterminate) + stock แดงถ้าติดลบ
- 25 รายการ/หน้า, pagination smart ellipsis
- Selected ข้ามหน้าได้

### 6. Modal จัดการลูกค้า/สมาชิก (`twinpet_customer_modal.html`)
- 3 คอลัมน์: Sidebar nav | Content | Profile summary panel
- 5 tabs: ข้อมูล / สมาชิก / บัญชีเชื่อ / ประวัติคำสั่ง / บันทึก
- Topbar: ยกเลิก + บันทึก มุมขวาบน
- Profile panel: photo, badges, quick stats, action buttons

### 7. ประวัติการขาย (`twinpet_sales_history.html`)
- Summary strip: ยอดรวม / บิลสำเร็จ / เงินเชื่อ / ยกเลิก / เงินสด
- Filter: search + date dropdown + status chips
- Table: เวลา | เลขบิล | ลูกค้า | ช่องทางชำระ | พนักงาน | ยอดสุทธิ | สถานะ
- Drawer: ข้อมูลลูกค้า + itemized list + payment summary + meta + void banner
- Footer: พิมพ์ใบเสร็จ (primary) + ยกเลิกบิล (red) → void modal ถามเหตุผล

---

## ⚙️ Business Logic ที่ตกลงแล้ว

### UOM
- หน่วยฐาน = ชิ้น, สต็อกเก็บเป็นชิ้นเสมอ
- Conversion table per product
- ราคาขายตั้งต่อหน่วยนับ ต่อระดับราคา

### ต้นทุน (FIFO + Avg Display)
| Layer | วิธี | หมายเหตุ |
|-------|------|----------|
| ตัดสต็อก (Backend) | FIFO | แยก batch ตามวันรับเข้า |
| แสดงผล (Frontend) | Average Cost | พนักงานดูง่าย |
| สต็อกติดลบ | ดึงต้นทุน lot ล่าสุดชั่วคราว | Recalculate เมื่อรับเข้า |
| ปรับต้นทุน | ต่อ lot โดยตรง + audit log | ไม่กระทบย้อนหลัง |

### VAT
- ตั้งค่าต่อ branch, สาขาไม่จด VAT → toggle ล็อค
- เอกสาร: จด VAT = ใบกำกับภาษี, ไม่จด = ใบเสร็จรับเงิน

### สต็อก
- แสดงเฉพาะสาขาที่ login
- ปรับได้เฉพาะสาขาตัวเอง, ดูสาขาอื่นได้ read-only

### ระดับราคา
- Custom ต่อหน่วยนับ, เพิ่ม/ลบได้ไม่จำกัด
- ตั้งใน Settings สาขา → inherit ทุกสินค้า

---

## 🔲 หน้าที่ยังค้างอยู่

- [ ] หน้า Login / เลือกสาขา
- [ ] Settings (VAT per branch, ระดับราคา global)
- [ ] ใบเสร็จ Thermal 80mm
- [ ] ใบเสร็จ A4 / Invoice / ใบกำกับภาษี
- [ ] Dashboard / รายงาน
- [ ] Excel สรุปยอดรายวัน
- [ ] Flow ใบเสนอราคา (Quotation) — มีใน transcript แต่ยังไม่ export HTML

---

## 📁 HTML Files ที่ส่งออกแล้ว
1. `twinpet_pos_v2.html` — หน้า POS หลัก
2. `twinpet_product_crud_v2.html` — จัดการสินค้า
3. `twinpet_customer_modal.html` — Modal ลูกค้า
4. `twinpet_sales_history.html` — ประวัติการขาย
5. `twinpet_pos_main.html` — หน้า POS v1 (เก่า)
6. `twinpet_product_crud.html` — จัดการสินค้า v1 (เก่า)

---

## 💬 Prompt เริ่มต้นแชทใหม่

```
ผมกำลังพัฒนา TwinPet POS System (React PWA, Firebase)
สำหรับร้านขายสัตว์เลี้ยง 2-3 สาขา

Design System:
- CSS vars: --p600:#534AB7 (primary), --g50:#F8F8FC (bg)
- Font: Prompt (ตัวเลข) + Sarabun (body)
- Topbar pattern: ← ชื่อหน้า | badge | [ยกเลิก] [บันทึก] มุมขวาบนเสมอ
- Footer: summary ตัวเลขอย่างเดียว ไม่มีปุ่ม

Costing: FIFO ตัดสต็อก, แสดง Average Cost ให้พนักงาน

หน้าที่เสร็จแล้ว:
POS หลัก, Modal ชำระเงิน, จัดการสินค้า (FIFO batch modal),
รับสินค้าเข้า, Dialog เลือกสินค้า, Modal ลูกค้า, ประวัติการขาย

ต้องการต่อ: [ระบุหน้าที่ต้องการ]
```
