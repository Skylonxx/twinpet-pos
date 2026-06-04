# 🐾 TwinPet POS — คู่มือ Emulator Persistence & Port Management

คู่มือนี้อธิบายระบบ **การคงอยู่ของข้อมูล (persistence)** และ **การจัดการพอร์ต (port management)** ของ Firebase Emulator ที่เราออกแบบเองสำหรับโปรเจกต์นี้ เพื่อให้ตั้งค่าใหม่ได้ง่ายเมื่อย้ายเครื่อง หรือใช้อ้างอิงในภายหลัง

> **TL;DR:** รัน `npm run dev:emulator` แล้วใช้งานได้เลย — ข้อมูลจะถูกเซฟอัตโนมัติทุก 5 วินาที และคงอยู่ข้ามการรีสตาร์ท ครั้งแรกสุดถ้าฐานข้อมูลว่าง ระบบจะ seed แอดมินให้อัตโนมัติ (`admin` / PIN `1234`)

---

## 1. ภาพรวม (Overview)

ฐานข้อมูล local ของเราถูกแยกเก็บเป็น **2 ส่วน** เพราะ Firebase Emulator มีข้อจำกัดสำคัญที่ทำให้ใช้กลไก native อย่างเดียวไม่ได้

### 🅰️ ส่วนที่ 1 — `emulator-data/` (Auth & Storage)

- เก็บข้อมูล **Firebase Auth** (บัญชีผู้ใช้/รหัสผ่าน) และ **Cloud Storage** (ไฟล์/รูป)
- ใช้กลไก **native** ของ Firebase: flag `--export-on-exit` และ `--import`
- ทำงานได้ดีอยู่แล้ว เพราะ Auth/Storage อยู่บนฐานข้อมูล `(default)` ที่ emulator รองรับการ export เต็มรูปแบบ
- ⚠️ persist **เฉพาะตอนปิดแบบสะอาด (clean exit)** เท่านั้น

### 🅱️ ส่วนที่ 2 — `.local-persist/pos-db-snapshot.json` (Firestore `pos-db`)

- เก็บข้อมูล **Firestore** ทั้งหมด: สินค้า, สาขา, ผู้ใช้, การตั้งค่า, ออเดอร์ ฯลฯ
- แอปเราใช้ **named database** ชื่อ `pos-db` (กำหนดใน `firebase.json` → `firestore.database`)
- 🔴 **ปัญหา:** `--export-on-exit` ของ Firebase **export ได้แค่ฐานข้อมูล `(default)` เท่านั้น** — มัน **ไม่เคย** เซฟ named database `pos-db` เลย → ข้อมูลหายทุกครั้งที่รีสตาร์ท (นี่คือสาเหตุที่แท้จริงของอาการ "ข้อมูลหายอีกแล้ว")
- ✅ **ทางแก้ของเรา:** สคริปต์ snapshot ที่เขียนเอง (`scripts/pos-db-snapshot.mjs`) อ่าน/เขียน `pos-db` ผ่าน **Emulator REST API** โดยตรง พร้อม **autosave ทุก 5 วินาที**

### ทำไมต้องแยกที่เก็บ?

`.local-persist/` ต้องอยู่ **นอก** โฟลเดอร์ `emulator-data/` เด็ดขาด เพราะ Firebase `--export-on-exit` จะ **ลบและสร้างโฟลเดอร์ `emulator-data/` ใหม่ทั้งหมด** ตอนปิด — ถ้าเก็บ snapshot ไว้ข้างในก็จะโดนลบทิ้งทุกครั้ง (เคยเกิดขึ้นมาแล้ว!)

| ส่วน | ที่เก็บ | กลไก | persist เมื่อไหร่ |
|------|---------|------|------------------|
| Auth & Storage | `emulator-data/` | native `--export-on-exit` | ตอนปิดสะอาด (Ctrl+C) |
| Firestore `pos-db` | `.local-persist/pos-db-snapshot.json` | custom REST snapshot | autosave ทุก 5 วินาที + ตอนปิด |

---

## 2. เริ่มต้นบนเครื่องใหม่ (Getting Started — New Machine)

เมื่อ clone โปรเจกต์มาลงเครื่องใหม่ ทำตามขั้นตอนนี้:

### ขั้นตอน

1. **ติดตั้ง dependencies**
   ```powershell
   npm install
   npm --prefix functions install
   ```

2. **ติดตั้ง Firebase CLI** (ถ้ายังไม่มี) และต้องมี **Java** (JDK 11+) เพราะ Firestore Emulator รันบน JVM
   ```powershell
   npm install -g firebase-tools
   ```

3. **บูตครั้งแรก**
   ```powershell
   npm run dev:emulator
   ```

### เกิดอะไรขึ้นในการบูตครั้งแรก (อัตโนมัติทั้งหมด)

- 🧹 **เคลียร์พอร์ตอัตโนมัติ** — ฆ่า process emulator เก่าที่ค้างอยู่ (เช่น Firestore JVM ที่ยึดพอร์ต 8080) ก่อนเริ่ม
- 📦 **import Auth/Storage** จาก `emulator-data/` ถ้ามี
- ♻️ **restore `pos-db`** จาก `.local-persist/pos-db-snapshot.json` ถ้ามี
- 🌱 **Failsafe auto-seed** — ถ้าฐานข้อมูล **ว่าง** (ไม่มี `users` หรือ `branches` เช่นบนเครื่องใหม่ที่ยังไม่มี snapshot) ระบบจะ seed ข้อมูลเริ่มต้นให้อัตโนมัติ:

  | รายการ | ค่า |
  |--------|-----|
  | สาขา | **สาขาหลัก** (`LDP-001`) |
  | Username | **admin** |
  | PIN | **1234** |
  | Password (email login) | **Admin@1234** |
  | Auth email | `admin@twinpet-pos.twinpet` |

  > คุณจะ **ไม่มีวันถูกล็อกเอาต์จากแอปเปล่า** — ถ้าไม่มีข้อมูล ระบบ seed แอดมินให้เสมอ

4. **เข้าใช้งาน** — เปิดแอป → เลือกสาขา **สาขาหลัก** → กรอก PIN **1234**

---

## 3. คำสั่งใช้งานประจำวัน (Daily Usage Commands)

### `npm run dev:emulator`  (เทียบเท่า `npm run dev`)

คำสั่งหลักที่ใช้ทุกวัน — ทำทุกอย่างให้อัตโนมัติแบบ self-healing:

1. เคลียร์พอร์ตที่ค้าง (`free:ports`)
2. import Auth/Storage จาก `emulator-data/`
3. สตาร์ท emulator ทั้งหมด (Auth, Functions, Firestore, Storage)
4. restore `pos-db` จาก snapshot → ถ้าว่างก็ auto-seed
5. เปิด autosave ทุก 5 วินาที
6. สตาร์ท Vite dev server (`http://localhost:5173`)

> `npm run dev` กับ `npm run dev:emulator` ชี้ไปที่สคริปต์เดียวกัน (`scripts/start-emulator.mjs`) จะพิมพ์อันไหนก็ได้ผลเหมือนกัน

### `npm run free:ports`

เคลียร์พอร์ต emulator ที่ค้างด้วยมือ — ใช้เมื่อเจอ error `Port 8080 is not open` / `port taken` หรือมี process ค้างหลังปิดไม่สะอาด

- อ่านพอร์ตจาก `firebase.json` โดยตรง (auth `9099`, functions `5001`, firestore `8080`, storage `9199`) บวกพอร์ต UI/hub (`4000/4400/4500`) และ websocket (`9150`)
- ทำงานข้ามแพลตฟอร์ม (Windows `netstat`/`taskkill`, macOS/Linux `lsof`/`kill`)
- ปกติ **ไม่ต้องเรียกเอง** เพราะ `dev:emulator` เรียกให้อยู่แล้วทุกครั้ง

### คำสั่งเสริม (Manual Snapshot)

ต้องให้ emulator รันอยู่ก่อน:

| คำสั่ง | หน้าที่ |
|--------|---------|
| `npm run snapshot:dump` | บันทึก `pos-db` → `.local-persist/pos-db-snapshot.json` ด้วยมือ |
| `npm run snapshot:restore` | กู้คืน `pos-db` จาก snapshot ด้วยมือ |
| `npm run seed:emulator` | seed สาขา + แอดมิน + role settings เข้า emulator ที่รันอยู่ |

---

## 4. คำเตือนสำคัญ (Critical Warnings)

### ⏱️ Autosave cushion 5 วินาที

- `pos-db` ถูกเซฟลง `.local-persist/` **อัตโนมัติทุก 5 วินาที** — นี่คือกลไกหลักที่รับประกันว่าข้อมูลไม่หาย
- **ความเสี่ยงสูงสุด:** ถ้าปิดทันทีหลังเพิ่มข้อมูล อาจเสียข้อมูลแค่ ≤ 5 วินาทีล่าสุด → เพิ่มข้อมูลเสร็จแล้วรอแป๊บนึง (หรือดูในแอปสักครู่) ก็ปลอดภัยแล้ว

### 🚪 ปิดหน้าต่าง vs Ctrl+C (Auth/Storage parity)

| วิธีปิด | Firestore `pos-db` | Auth & Storage |
|---------|--------------------|----------------|
| **Ctrl+C แล้วรอจนปิดสนิท** ✅ | ปลอดภัย (autosave + final dump) | **ปลอดภัย** (native export ทำงาน) |
| **ปิดหน้าต่าง / kill ทันที** ⚠️ | ปลอดภัยถึง autosave ล่าสุด (≤5 วิ) | 🔴 **อาจไม่ถูกเซฟ!** |

- **Firestore `pos-db`** ทนทานต่อการปิดแบบ hard kill เพราะ autosave เก็บไว้นอกโฟลเดอร์ที่โดนลบ
- **Auth & Storage** ใช้ native export ที่ทำงาน **เฉพาะตอนปิดสะอาด (clean exit)** เท่านั้น → ถ้าปิดหน้าต่างดื้อๆ บัญชีผู้ใช้/รหัสผ่านใหม่ที่เพิ่งสร้างอาจหาย
- ⚠️ **หมายเหตุ Windows:** ตอน Ctrl+C ระบบส่งสัญญาณไปปิด Firestore JVM ด้วย ทำให้ **final dump ตอนปิดมักล้มเหลว** (`fetch failed`) — แต่ **ไม่เป็นไร** เพราะ autosave 5 วินาทีเก็บข้อมูลไว้ก่อนหน้านั้นแล้ว
- 👉 **สรุป:** ใช้ **Ctrl+C แล้วรอจนเห็นข้อความปิด emulator ครบ** เป็นนิสัยที่ดีที่สุด เพื่อให้ทั้ง Firestore และ Auth/Storage ตรงกัน (parity)

### 🔴 ทำไม named database `pos-db` ถึงต้องใช้ทางแก้พิเศษนี้

- Firebase Emulator `--export-on-exit` **รองรับเฉพาะฐานข้อมูล `(default)`**
- แอปเราจงใจใช้ named database `pos-db` (เพื่อแก้ปัญหา missing-index / reconcile บน production — ดู `src/lib/firebase.ts`)
- เราเลือก **คงความเหมือนกันระหว่าง dev กับ prod (strict parity)** — ใช้ `pos-db` ทั้งสองที่ ไม่สลับไป `(default)` ตอน dev
- ดังนั้นจึงต้องเขียน custom REST snapshot เองเพื่ออุดช่องโหว่นี้

---

## 📁 ไฟล์ที่เกี่ยวข้อง (Reference)

| ไฟล์ | หน้าที่ |
|------|---------|
| `scripts/start-emulator.mjs` | จุดเริ่มต้น: เคลียร์พอร์ต → import → สตาร์ท emulator → ส่งต่อให้ orchestrator |
| `scripts/free-emulator-ports.mjs` | เคลียร์พอร์ตที่ค้าง (อ่านพอร์ตจาก `firebase.json`) |
| `scripts/dev-after-emulators.mjs` | orchestrator: restore → failsafe seed → autosave 5 วิ → สตาร์ท Vite |
| `scripts/pos-db-snapshot.mjs` | dump/restore `pos-db` ผ่าน REST API |
| `scripts/seed-emulator.mjs` | seed สาขา + แอดมิน + role settings |
| `.local-persist/pos-db-snapshot.json` | ไฟล์ snapshot ของ `pos-db` (gitignored) |
| `emulator-data/` | export ของ Auth/Storage จาก Firebase native (gitignored) |

---

## 🔧 กฎการบำรุงรักษา (Maintenance Rule)

> **หากมีการแก้ไขสคริปต์ ระบบความปลอดภัย หรือโครงสร้างพอร์ตในอนาคต ให้ Claude คอยอัปเดตไฟล์ EMULATOR_GUIDE.md นี้ให้เป็นเวอร์ชันล่าสุดเสมอ**
