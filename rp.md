● การวิเคราะห์เสร็จแ—้Batch 2 ชัดเจนและมี"บทเรียนBatch 1" สำคัญที่ต้องใส่ใ(คลาสรั่วข้ามไ→ลต้องmigrate ผู้ใช้ร่วมก่CSS)

  ---
  📐 แผน Phase 2 — Batch 2: Layouts & Navigation

  1️ Target Identification

  กลุ่มหลัก (3 layout)

  ┌────────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────┐    
  │                  ไฟล์                  │                                 สิ่งที่migrate                                  │                   ความซับซ้อน                  │    
  ├────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤    
  │ AppShell.tsx + AppShell.css            │ sidebar รางย่อ-ขยาย(60↔232px) + accordion + footer + branch-badge +             │ 🔴 สูง(รางคลิกขยาย+ accordion +                │    
  │                                        │ topbar-title                                                                    │ collapsed-rail)                                │    
  ├────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤    
  │ AdminLayout.tsx + AdminLayout.css      │ topbar + sidebar นิ่240px + nav list + main                                     │ 🟢 ต่ำ                                         │    
  ├────────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────┤    
  │ SettingsLayout.tsx +                   │ topbar + sidebar นิ่240px + nav แบบกลุ่+ badge                                  │ 🟢 ต่ำ                                         │    
  │ SettingsLayout.css                     │                                                                                 │                                                │    
  └────────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────┘    

  กลุ่มรอ(ผู้ใช้คลาสร—วต้องแก้ด้วยเพืCSSบได้สนิท)

  จาก grep พบว่าคลาสใน3 ไฟล์CSS ข้างบนถูกใช้นอกไฟlayout ด้วย(บทเรียนsr-badge ของ Batch 1 ซ้ำอีก):

  ┌────────────────────────────┬────────────────────┬───────────────────────────────────────────────┐
  │            คลาส            │       นิยามใน      │                 ถูกใช้นอกไฟล์โดย              │
  ├────────────────────────────┼────────────────────┼───────────────────────────────────────────────┤
  │ .app-loading               │ AppShell.css       │ GuestRoute.tsx, ProtectedRoute.tsx            │
  ├────────────────────────────┼────────────────────┼───────────────────────────────────────────────┤
  │ .page-placeholder*         │ AppShell.css       │ PagePlaceholder.tsx                           │
  ├────────────────────────────┼────────────────────┼───────────────────────────────────────────────┤
  │ .admin-layout-placeholder* │ AdminLayout.css    │ AdminPlaceholderPage.tsx                      │
  ├────────────────────────────┼────────────────────┼───────────────────────────────────────────────┤
  │ .pc-settings-*             │ SettingsLayout.css │ (ใช้แคSettingsLayout.tsx — จะ verify ซ้ำก่อนลบ│
  └────────────────────────────┴────────────────────┴───────────────────────────────────────────────┘

  ▎ 👉 ถ้าไมmigrate กลุ่มรองก่การลบ CSS จะทำให้loading screen / placeholder pages หน้าตาพัง

  ---
  2️⃣กลยุทธMapping — Tailwind compose (ไม่ใชFlowbite Sidebar/Navbar)

  ตัดสินใจใช้Tailwind utility ประกอบเอง ไม่ใช<Sidebar>/<Navbar> ของ Flowbite

  เหตุผล(อิงบทเรียBatch 1 — component ที่ไfit สร้างปัญหา):
  - AppShell sidebar เป็นรางคลิกขยายเฉพาะตั(60↔232px) + accordion เปิดทีละกล+่collapsed-rail จัดไอคอนกลาง+ ธีมม่วงเข--p900 เป๊ะ→ Flowbite <Sidebar> มีโครงสร้าง/พฤติกรcollapse     
  แบบของมันเองจะตีกับดีไซน์เดิมและUXีเพี้ย(แบบเดียวกัTableHeadCell/Datepicker)
  - Admin/Settings sidebar เป็นnav list นิ่240px → Tailwind ง่ายๆไม่ต้องใFlowbite
  - Topbar เป็นflex bar ธรรมดา → Tailwind ไม่ใช<Navbar> (Navbar มีhamburger/brand/collapse ที่เราไม่ต้องการ)

  ใช้ui primitive เฉพาะทีfit จริง:
  - Settings nav badge → <Badge color="failure">
  - ปุ่topbar ของ Admin (logout / เปลี่ยworkspace) → <Button size="xs" color="light"> (ออปชัน— หรือคงTailwind button เพื่อความเป๊ะ)

  การจัดการรางย่อ-ขยา(collapsible rail):
  - คง useState open เดิม+ accordion state เดิมไม่แตะlogic
  - แปลง selector .is-open / :not(.is-open) เป็นconditional Tailwind class ใน JSX ขับด้วopen:
    - ความกว้าง:${open ? 'w-[232px]' : 'w-[60px]'} transition-[width] duration-200
    - ป้าย/โลโก้/chevron${open ? 'inline' : 'hidden'}
    - cat-head ตอนหุบ:${open ? '' : 'justify-center px-0 gap-0'}
  - accordion เปิด(keyframe app-shell-sub-in) → ย้ายเป็Tailwind animate-* หรือเก็keyframe เล็กๆใน index.css (@theme) แล้วใชutility

  ---
  3️⃣Execution Steps

  Step A — AppShell.tsx (หัวใจ,ทำก่อน+ ระวังสุด)
  - แปลง sidebar + head/logo + nav accordion + sub-link + footer + user-block + logout + branch-badge + topbar-title → Tailwind
  - แทน .is-open descendant selectors ด้วยconditional class จาก open
  - map สี:bg-[var(--p900)], active sub-link bg-[var(--p600)], ข้อความrgba ขาว → text-white/55 ฯลฯ

  Step B — ผู้ใช้คลาสร่วมAppShell.css
  - PagePlaceholder.tsx (page-placeholder* → Tailwind)
  - GuestRoute.tsx + ProtectedRoute.tsx (app-loading → Tailwind: flex items-center justify-center h-screen ...)
  - → ครบแล้วAppShell.css ลบได้สนิท

  Step C — AdminLayout.tsx + AdminPlaceholderPage.tsx
  - AdminLayout topbar/sidebar/nav/main → Tailwind (สี--g400/--g600 ไม่มีใtoken global → ใช้literal #888780/#5f5e5a)
  - AdminPlaceholderPage (admin-layout-placeholder* → Tailwind) → AdminLayout.css ลบได้สนิท

  Step D — SettingsLayout.tsx
  - topbar/sidebar/grouped nav/badge/main → Tailwind (verify pc-settings ไม่มีผู้ใช้อื่นก่อนลบ)

  Step E — ลบไฟล์CSS (ดูข้4)

  Step F — Build + Runtime Smoke Test (บังคับ)
  - บทเรียน:tsc จับruntime ไม่ไดและ nav เป็นcritical path ทุกหน้า
  - เช็ค:sidebar ย่อ/ขยาย+ accordion + active state, /admin layout, /settings layout + badge, placeholder pages, loading screens

  ---
  4️⃣CSS Deletion

  ลบทั้งไฟ3์ไฟล์(หลังmigrate ผู้ใช้คลาสร่วStep B/C แล้วเท่าน+้grep ยืนยันก่อนลบทุกครั้ง):

  ┌────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────┐
  │              ไฟล์              │                                   ลบได้เมื่อ                                 │
  ├────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ src/components/AppShell.css    │ หลังAppShell.tsx + PagePlaceholder + GuestRoute + ProtectedRoute migrate ครบ │
  ├────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ src/layouts/AdminLayout.css    │ หลังAdminLayout.tsx + AdminPlaceholderPage migrate                           │
  ├────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤
  │ src/layouts/SettingsLayout.css │ หลังSettingsLayout.tsx migrate (+ verify ไม่มีผูpc-settings อื่น)            │
  └────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────┘

  ➡️ Batch นี้กำจlegacy CSS ได้3 ไฟล์เต็ม

  ---
  ⚠️ ความเสี่ย& หมายเหตุ

  - AppShell = ความเสี่ยงสูง—ุทุกหน้าอยู่ใถ้าพั= พังทั้งแ→ปsmoke test บังคั(ไม่ใช่แbuild)
  - local var --g400/--g600 ไม่มีใvariables.css → ใช้literal hex
  - งาน additive น้อย,แก้ของเดิมเยอ→ ทำทีละlayout, build/smoke ระหว่างทาง

  ออปชันการซอยbatch: ถ้าอยากปลอดภัยกวแยกเป็น2a = AppShell (เสี่ยงสูทำเดี่ยว+ smoke) แล้ว2b = Admin/Settings layouts (เสี่ยงต่—)หรือทำรวดเดียวก็ได้เพ3าlayout เป็นอิสระต่อกัน       

  ---
  ผมจะ ไม่แก้โค้ดจนกว่าคุณจ"GO"พครับ— อยากทำรวดเดียว(2a+2b) หรือแยกAppShell ออกมาก่อน?และปุ่topbar ของ Admin อยากให้ใช<Button> ของ Flowbite หรือคงTailwind button
  เพื่อความเป๊ะของดีไซน์เดิมครับ?

✻ Crunched for 2m 34s