# 🚀 Twinpet POS - Deployment Guide

คู่มือฉบับย่อสำหรับการอัปเดตระบบ Twinpet POS ขึ้น Production (Firebase)
เมื่อแก้ไขโค้ดเสร็จแล้ว ให้เลือกใช้คำสั่งตามหมวดหมู่ด้านล่างนี้ โดยรันคำสั่งที่โฟลเดอร์หลักของโปรเจกต์ (`twinpet-pos`)

---

## 1. ⚙️ อัปเดตระบบจัดการบิล / โค้ดหลังบ้าน (Cloud Functions)
*ใช้เมื่อ: มีการแก้ไขโค้ดในโฟลเดอร์ `functions` (เช่น แก้วิธีตัดสต็อก FIFO, ตรวจสอบ PIN)*

```bash
cd functions
npm run deploy
(หมายเหตุ: คำสั่งนี้จะทำการ Build โค้ด และอัปโหลด Functions ทั้งหมดที่กำหนดไว้ใน package.json ขึ้นไปอัตโนมัติ)

2. 🗂️ อัปเดตระบบค้นหา / แดชบอร์ด (Firestore Indexes)
ใช้เมื่อ: มีการอัปเดตไฟล์ firestore.indexes.json (เช่น ทำหน้าแดชบอร์ดใหม่ที่ต้องการ Query ซับซ้อน)

Bash
npx firebase-tools deploy --only firestore:indexes
3. 🛡️ อัปเดตระบบรักษาความปลอดภัย (Firestore Rules)
ใช้เมื่อ: มีการแก้ไขไฟล์ firestore.rules (เช่น เปลี่ยนสิทธิ์การเข้าถึงข้อมูลของพนักงาน)

Bash
npx firebase-tools deploy --only firestore:rules
4. 🌐 อัปเดตหน้าเว็บหน้าร้าน (Frontend / UI)
ใช้เมื่อ: วาดหน้าจอเสร็จ แก้สีปุ่ม หรือเพิ่มหน้าเว็บใหม่ แล้วต้องการเอาขึ้นให้พนักงานใช้งานจริง

Bash
npm run build
npx firebase-tools deploy --only hosting
💡 ทริคฉุกเฉิน (Troubleshooting)
ถ้าบิลค้างไม่ยอมตัดสต็อก (asyncOrders ไม่เข้า orders):
ให้เช็คที่เว็บไซต์ [Firebase Console] -> เมนู Functions -> กดดูแถบ Logs (ระบบจะบอกเลยว่าพนักงานหลังบ้านเราสะดุดบั๊กบรรทัดไหน)

ลบ Cloud Function ที่ไม่ได้ใช้งาน (ลบขยะ):

Bash
  npx firebase-tools functions:delete <ชื่อฟังก์ชัน>
เช็คว่าเราเชื่อมต่อกับ Database ตัวไหนอยู่:
ดูที่ไฟล์ firebase.json ตรงบรรทัด "database": "pos-db"


***

แค่นี้บอสก็จะมีคู่มือประจำตัวติดอยู่ในโปรเจกต์แล้วครับ! สบายใจได้ยาวๆ เลยครับลูกพี่! 🫡✨