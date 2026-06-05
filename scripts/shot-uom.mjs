import { chromium } from '@playwright/test';
const BASE='http://localhost:5173';
const errors=[];
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:900}});
page.on('console',m=>{ if(m.type()==='error') errors.push(m.text()); });
page.on('pageerror',e=>errors.push('pageerror: '+e.message));
const shot=async n=>{ await page.screenshot({path:`.shots-uom/${n}.png`}); console.log(`  📸 ${n}.png`); };

await page.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'});
await page.waitForSelector('#branch-sel',{state:'visible',timeout:20000});
await page.waitForFunction(()=>document.querySelectorAll('#branch-sel option[value]:not([value=""])').length>0,{timeout:20000});
const v=await page.$$eval('#branch-sel option',os=>os.map(o=>o.value).filter(Boolean));
await page.selectOption('#branch-sel',v.includes('LDP-001')?'LDP-001':v[0]);
for(const d of ['1','2','3','4']){await page.click(`.login-pin-btn:text-is("${d}")`);await page.waitForTimeout(300);}
await page.waitForFunction(()=>{try{const s=JSON.parse(localStorage.getItem('twinpet_session'));return!!(s?.user?.id&&s?.branchId);}catch{return false;}},{timeout:25000});
console.log('login OK');

await page.goto(`${BASE}/products`,{waitUntil:'domcontentloaded'});
await page.waitForTimeout(1500);
// open "add product" drawer
await page.getByRole('button',{name:/เพิ่มสินค้า/}).first().click();
await page.waitForSelector('.pc-dialog-overlay',{timeout:6000});
await page.waitForTimeout(700);
await shot('01-drawer-open');

// locate the Base UOM combobox trigger inside .pc-base-unit-row
const baseTrigger = page.locator('.pc-base-unit-row button').first();
const before = (await baseTrigger.innerText()).trim();
console.log(`baseUOM trigger BEFORE = "${before}"`);
await baseTrigger.click();
await page.waitForTimeout(400);
await shot('02-baseuom-open');

// type a filter into the search box
const search = page.getByPlaceholder('ค้นหาหน่วย...').first();
await search.fill('กล');
await page.waitForTimeout(400);
await shot('03-baseuom-filtered');
// click the filtered option "กล่อง"
await page.getByRole('menuitem',{name:/กล่อง/}).first().click().catch(async()=>{
  await page.getByText('กล่อง',{exact:false}).first().click();
});
await page.waitForTimeout(500);
const after = (await baseTrigger.innerText()).trim();
console.log(`baseUOM trigger AFTER  = "${after}"  (changed=${before!==after})`);
await shot('04-baseuom-selected');

// read the live React state baseUnit by reading the trigger label (proxy) — and
// confirm by toggling multi-UOM then adding a sub-uom to test the sub combobox
await safeClickMulti();
async function safeClickMulti(){
  try{
    const t = page.getByText(/มีหลายหน่วยนับ/).first();
    if(await t.count()){ await t.click(); await page.waitForTimeout(500); }
    const addBtn = page.getByRole('button',{name:/เพิ่มหน่วยย่อย/});
    if(await addBtn.count()){ await addBtn.first().click(); await page.waitForTimeout(500); await shot('05-subuom-added'); 
      const subTrigger = page.locator('.pc-uom-card select, .pc-uom-card button').filter({hasText:/เลือกหน่วย|ชิ้น|กล่อง|แพ็ค|โหล|ลัง|ถุง|ขวด|กิโล/}).first();
      if(await subTrigger.count()){ await subTrigger.click(); await page.waitForTimeout(300);
        const s2 = page.getByPlaceholder('ค้นหาหน่วย...').last();
        await s2.fill('แพ'); await page.waitForTimeout(300);
        await page.getByText('แพ็ค',{exact:false}).first().click().catch(()=>{});
        await page.waitForTimeout(400); await shot('06-subuom-selected');
        const subAfter=(await subTrigger.innerText().catch(()=> '')).trim();
        console.log(`subUOM trigger AFTER = "${subAfter}"`);
      }
    }
  }catch(e){ console.log('sub-uom step note: '+(e?.message??e)); }
}

console.log('\nconsole errors:', errors.length? errors : '(none)');
await browser.close();
