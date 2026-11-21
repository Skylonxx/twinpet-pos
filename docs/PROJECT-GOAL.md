# Twinpet POS — Project Goal (MP0 proposal)

**Version:** 0.1 DRAFT · **Prepared:** 2026-11-21 · **Owner:** Product Owner  
**Approval:** MP0 planning authorized; **next implementation phase NOT AUTHORIZED**.  
**Authority:** existing `docs/agent-workflow/{STATE,CURRENT_PACKET,NEXT_ACTION}.md` + `AUTHORITY_MATRIX.md` control current gate until explicit adjudication. No replacement by this draft.

## Product outcome
ส่งมอบ **Twinpet POS แบบ Windows Native/Tauri TRUE-STANDALONE** ที่แคชเชียร์สามารถขายหน้าร้านได้อย่างปลอดภัยแม้เน็ตล่ม โดยบันทึกลง Local Durable Store ก่อน และซิงก์กับ Firestore อย่างถูกต้องเมื่อกลับออนไลน์

## Proposed definition of done (release-facing)
1. ขาย/รับชำระออฟไลน์และปิด/เปิดแอปใหม่ได้ โดยบิลที่รับไว้ไม่หายและไม่ถูกสร้างซ้ำหลังเชื่อมต่อ
2. Cloud reconciliation พิสูจน์ order/payment/stock movement อย่างละหนึ่งตามเหตุการณ์จริง ไม่ตัดสต็อกซ้ำ; ยอดสาขาไม่ปะปน
3. เปิด/ปิดกะและแสดงสถานะ local pending vs server-confirmed อย่างถูกต้องตาม Offline First (ห้ามเปลี่ยนให้ Online-only โดยไม่อนุมัติ)
4. งานแคชเชียร์จำเป็น: ใบเสร็จ/พิมพ์ซ้ำ, พักบิล, void/manager authorization, payment modalities, sales history/stock truth ผ่าน UAT บน build ที่ระบุ commit/source ได้
5. ทดสอบ Installer/Upgrade จากเวอร์ชันที่ร้านใช้อยู่โดยไม่สูญเสียข้อมูล durable และเคารพ fail-closed/monotonic epoch
6. Product Owner มีผล UAT, รายการ blockers/risks, บันทึก GO/NO-GO และอนุมัติ Release แยกก่อนใช้งาน Production

## Non-goals ของขั้น Planning นี้
ไม่ใช่การเปิด Return/Refund, Server-Authoritative Shift Close, Android/Capacitor, EV-2 hard reset, broad mutation campaign, Git merge หรือ Production rollout. ไม่ออก Cloud/Rules/Functions Deploy ใหม่. หลัก Offline First เป็นข้อผูกมัดถาวร

## What counts as evidence
ต้องแยก SOURCE_CLOSED, TEST_PASS, NATIVE_UAT_PASS, RELEASE_READY และ OWNER_RELEASE_APPROVED ออกจากกัน. แสดงที่มาของ test command/build hash, candidate identity, ข้อมูลจำลอง vs จริง และข้อจำกัด; ไม่ถือว่าการ Compile ผ่านเท่ากับขายได้จริง

## Source lineage
- Current technical baseline used for rebaseline proposal: GitHub main `f034301c46dd9e08190f869cc85dbb140ac28a3c` observed 2026-11-21
- Previous accepted closed phases are unchanged; reference `docs/agent-workflow/` and `docs/skills/SKILL-GLOBAL-ARCHITECTURE.md`
- Execution board: [Twinpet POS — Planning (Todoist)](https://app.todoist.com/app/project/6j43w86FgC6PhQh6)
