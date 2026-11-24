# US Stock Tracker — ติดตามราคาหุ้นสหรัฐ

หน้าเว็บเดียว (`index.html`) สำหรับติดตามหุ้นสหรัฐและ ETF

- ราคา USD, ส่วนต่างวันนี้, Volume, ช่วง 52 สัปดาห์ (Yahoo Finance)
- กราฟแท่งเทียน/เส้น + Volume, SMA 20/50 (TradingView Lightweight Charts)
- แนวรับ–แนวต้านอัตโนมัติจาก swing high/low 1 ปี + Classic Pivot Points
- กราฟ TradingView และสรุปสัญญาณเทคนิค (วิดเจ็ตทางการของ TradingView)
- กลุ่ม Magnificent 7, ETF ยอดนิยม, S&P 500 ทั้งหมด (กรอง/เรียง/สรุปตามกลุ่มอุตสาหกรรม) และรายการของฉัน
- ข่าวล่าสุดของแต่ละหุ้นจาก Yahoo Finance แปลเป็นภาษาไทยอัตโนมัติ

## แหล่งข้อมูล (ฟรี ไม่ต้องใช้ API key)

| ข้อมูล | แหล่ง |
|---|---|
| ราคา / กราฟ / ค้นหา / ข่าว | Yahoo Finance (ผ่าน Supabase Edge Function `yahoo`) |
| รายชื่อหุ้น S&P 500 | Wikipedia — List of S&P 500 companies (แคช 12 ชม.) |
| กราฟและสัญญาณเทคนิค | TradingView embed widgets |
| แปลข่าว | Google Translate (เรียกจากเบราว์เซอร์) |

## โครงสร้าง

```
index.html                        หน้าเว็บ (static) — เปิดตรงหรือ deploy ที่ใดก็ได้
supabase/functions/yahoo/index.ts Edge Function: ?type=chart|search|news|quotes|sp500
```

Supabase project: `vyutsvlusxyuoqjxxusi` (Stock Price) — หน้าเว็บใช้ anon key ซึ่งเป็น public key ตามปกติของ Supabase

ใช้ประกอบการวิเคราะห์เท่านั้น ไม่ใช่คำแนะนำการลงทุน
