# US Stock Tracker — ติดตามราคาหุ้นสหรัฐ

หน้าเว็บเดียว (`index.html`) สำหรับติดตามหุ้นสหรัฐและ ETF

- ราคา USD, ส่วนต่างวันนี้, Volume, ช่วง 52 สัปดาห์ (Yahoo Finance)
- กราฟแท่งเทียน/เส้น + Volume, SMA 20/50 (TradingView Lightweight Charts)
- แนวรับ–แนวต้านอัตโนมัติจาก swing high/low 1 ปี + Classic Pivot Points
- กราฟ TradingView และสรุปสัญญาณเทคนิค (วิดเจ็ตทางการของ TradingView)
- กลุ่ม Magnificent 7, ETF ยอดนิยม, S&P 500 ทั้งหมด (กรอง/เรียง/สรุปตามกลุ่มอุตสาหกรรม) และรายการของฉัน
- ข่าวล่าสุดของแต่ละหุ้นจาก Yahoo Finance แปลเป็นภาษาไทยอัตโนมัติ
- Heat map S&P 500 (ขนาดตามมูลค่าตลาด สีตาม % เปลี่ยนแปลง แยกตามกลุ่มอุตสาหกรรม)
- หัวข่าว Bloomberg (RSS สาธารณะ) แปลไทย
- Champion Screen: Trend Template 8 ข้อของ Mark Minervini + RS rating + VCP (ประมาณการ) + ตัวคำนวณจุดตัดขาดทุนและขนาดไม้
- จำลองการเทรดรายวันสไตล์ Minervini (Think & Trade Like a Champion): ย้อนหลัง 3/6/12 เดือน และ paper trade เริ่ม 27 พ.ย. 2026 เทียบ SPY/QQQ พร้อมตัวเลือก ETF ขาลง SH/PSQ/SQQQ
- แท็บ ETF ขาลง (Inverse): SH, PSQ, DOG, RWM, SDS, QID, SPXU, SQQQ
- หุ้นเด่นประจำวัน: สัญญาณทางเทคนิคจากการคัดกรอง S&P 500 ตามกฎที่เปิดเผย (ไม่ใช่คำแนะนำการลงทุน)

## แหล่งข้อมูล (ฟรี ไม่ต้องใช้ API key)

| ข้อมูล | แหล่ง |
|---|---|
| ราคา / กราฟ / ค้นหา / ข่าว | Yahoo Finance (ผ่าน Supabase Edge Function `yahoo`) |
| มูลค่าตลาด | Yahoo Finance v7 quote |
| หัวข่าว Bloomberg | feeds.bloomberg.com (RSS สาธารณะ — ข้อมูลราคาของ Bloomberg ต้องใช้ Terminal แบบเสียเงิน) |
| รายชื่อหุ้น S&P 500 | Wikipedia — List of S&P 500 companies (แคช 12 ชม.) |
| กราฟและสัญญาณเทคนิค | TradingView embed widgets |
| แปลข่าว | Google Translate (เรียกจากเบราว์เซอร์) |

## โครงสร้าง

```
index.html                        หน้าเว็บ (static) — เปิดตรงหรือ deploy ที่ใดก็ได้
supabase/functions/yahoo/index.ts Edge Function: ?type=chart|search|news|quotes|sp500|caps|bloomberg|pick|champion|sim
```

Supabase project: `vyutsvlusxyuoqjxxusi` (Stock Price) — หน้าเว็บใช้ anon key ซึ่งเป็น public key ตามปกติของ Supabase

ใช้ประกอบการวิเคราะห์เท่านั้น ไม่ใช่คำแนะนำการลงทุน
