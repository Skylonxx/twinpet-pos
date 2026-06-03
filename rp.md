 Only the two staff pages consume these classes, and both are now updated identically. tsc -b exit 0.

  ✅ Internal scroll enforced across all 3 tabs

  Files audited & fixed (shared StaffManagementPage.css + identical structure):
  - src/pages/admin/AdminStaffManagementPage.tsx — route /admin/staff
  - src/pages/StaffManagementPage.tsx — route /staff (same shell, so it needed the matching TSX fix too)                                                                      

  The fix in one picture

  The shell was already viewport-bound (.sm-page = height:100%; overflow:hidden). The problem was the scroll living on .sm-content, so toolbar + headers scrolled away. I moved the scroll
  into each tab's table/matrix wrapper:

  .sm-page (overflow:hidden)
   └─ .sm-content (flex column, overflow:HIDDEN now)   ← was overflow-y:auto
       ├─ .sm-toolbar (flex-shrink:0)                  ← stays pinned
       └─ .sm-card (flex:1; display:flex; column)      ← fills remaining height
           ├─ tables: .sm-table-scroll (flex:1; overflow:auto)   ← rows scroll
           └─ perms:  .sm-perm-matrix-header (flex-shrink:0)     ← header pinned
                      .sm-perm-scroll (flex:1; overflow-y:auto)  ← rows scroll

  CSS changes (StaffManagementPage.css):

  ┌────────────────────────┬────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │        Selector        │                                                       Change                                                       │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-content            │ overflow-y:auto → overflow:hidden (stops content-level scroll)                                                     │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-toolbar            │ +flex-shrink:0 (toolbar pinned)                                                                                    │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-card               │ +flex:1; min-height:0; display:flex; flex-direction:column                                                         │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-table-scroll       │ overflow-x:auto → overflow:auto; flex:1; min-height:0 (vertical scroll, fills card)                                │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-perm-scroll        │ new — overflow-y:auto; flex:1; min-height:0                                                                        │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-perm-matrix-header │ +flex-shrink:0 (pinned above the scroll region)                                                                    │
  ├────────────────────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ .sm-page thead th      │ +position:sticky; top:0; z-index:1 (sticky headers — th already had a solid --g50 background, so no bleed-through) │
  └────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

  TSX change (both files): wrapped the Tab 2 permissions matrix body in <div className="sm-perm-scroll"> so the matrix header stays pinned while rows scroll. Tabs 1 & 3 needed no markup 
  change — the CSS upgrade to .sm-table-scroll does it.

  Result per tab

  ┌────────────────────┬────────────────────────────────────────────────────────────┬─────────────────────────┐
  │        Tab         │                      Internal scroll                       │      Sticky header      │
  ├────────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────┤
  │ 1 — พนักงาน(table) │ ✅ rows scroll in .sm-table-scroll; toolbar/filters pinned │ ✅ <thead> sticky       │
  ├────────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────┤
  │ 2 — สิทธ(matrix)   │ ✅ rows scroll in .sm-perm-scroll                          │ ✅ matrix header pinned │
  ├────────────────────┼────────────────────────────────────────────────────────────┼─────────────────────────┤
  │ 3 — ประวัต(table)  │ ✅ rows scroll in .sm-table-scroll; chips/Export pinned    │ ✅ <thead> sticky       │
  └────────────────────┴────────────────────────────────────────────────────────────┴─────────────────────────┘

  Horizontal scroll is preserved too (overflow:auto keeps the min-width:700px tables scrollable on narrow viewports).

  Note: this is a layout change tsc can't visually verify. If you want certainty, I can launch the dev app, seed a long staff/activity list, and screenshot each tab to confirm the rows  
  scroll internally with the header pinned. Otherwise this is ready.

✻ Cooked for 4m 3s