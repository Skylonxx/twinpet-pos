  Searchable UOM Dropdown — DONE ✅

  1. Analyzed the existing pattern

  The Category field uses CategoryCombobox — a Flowbite <Dropdown> whose DropdownHeader hosts a <TextInput> search box, with the list
  rendered as filtered <DropdownItem>s (typeahead). No third-party lib; pure flowbite-react composition bound via value/onChange.       
                                                                                                                            
  2. Built a reusable UnitCombobox

  Created src/components/products/UnitCombobox.tsx — the same composition as CategoryCombobox but for plain unit-name strings (the UOM
  data is string[], simpler than category objects). Props: options, value, onChange, placeholder, invalid, inputRef. Adds a ✓ check on
  the currently-selected item.

  3. Replaced both native <select>s in ProductDrawer (the shared edit form)

  - Base UOM (หน่วยนับหลัก<select> → <UnitCombobox>, preserving the invalid state, the error-clear-on-change, and the
  focus-first-invalid unitRef (retyped HTMLSelectElement→HTMLInputElement so it focuses the search box, exactly like the Category       
  field). The gear "จัดการหน่วยนัbutton stays beside it.
  - Sub-UOM (หน่วยย่อยinside UomPricingCard): <select> → <UnitCombobox> with placeholder "— เลือกหน่ว—", onChange → onUpdate({ unit }). 

  Both ProductCRUDPage and AdminProductManagementPage render this one ProductDrawer, so both are covered by the single change.

  4. Data-binding integrity (the critical part)

  The option builders (buildUnitSelectOptions / buildSubUnitSelectOptions) are unchanged — they still produce the same unit strings     
  (including legacy-value prepending and base-unit/used-unit exclusion). The combobox simply feeds the selected string into the same    
  state setters (setBaseUnit / onUpdate({unit})), so the exact same unit codes save to the DB. No data-shape change.

  5. Verification (headless, real app)

  - Base UOM: "ชิ้น→ typed "กล" → selected → "กล่อง"(state changed ✓)
  - Sub-UOM: enabled multi-UOM → default "กิโลกรัม→ typed "โห" → selected → "โหล" (state changed ✓), base unit "ชิ้นcorrectly excluded  
  from the list
  - 0 console errors on both flows; tsc -b + vite build green
  - Screenshots confirm the visual polish matches the Category dropdown — trigger + chevron, search header, ✓ on selected item,
  widths/alignment intact within the Flowbite form layout

  Consistent-UX summary

  By extracting the same Dropdown-with-search composition the Category field already uses into a dedicated UnitCombobox, the Base and   
  Sub UOM pickers now behave and look identical to Category (type-to-filter, "ไม่พบหน่วยempty state, same border/focus styling) — so the
  admin gets one consistent searchable-select interaction across the whole product form.

  One housekeeping note: I had to restart the dev server mid-task — the previous emulator backend had died (snapshot autosave was       
  logging fetch failed), so I freed ports and relaunched dev:emulator cleanly before verifying. It's running now.

✻ Sautéed for 14m 34s · 1 shell still running