# Rennic Jersey — Web Store

## ไฟล์ที่ได้
- `index.html` — หน้าร้านสำหรับลูกค้า
- `admin.html` — Admin panel จัดการสินค้า + ออเดอร์

## Login Admin
- Username: `rennic`
- Password: `jersey2021`
(เปลี่ยนได้ในไฟล์ admin.html บรรทัด ADMIN_USER และ ADMIN_PASS)

## ตั้งค่า Google Sheet
ต้องสร้าง Sheet เพิ่ม 2 Sheet ใหม่ในไฟล์เดิม:

### Sheet "Store" (สินค้าหน้าร้าน)
แถวที่ 1 ใส่หัวคอลัมน์:
`id | name | type | size | price | desc | img | status`

### Sheet "Orders" (คำสั่งซื้อ)
แถวที่ 1 ใส่หัวคอลัมน์:
`date | name | phone | address | items | total | note | status`

## Deploy บน Vercel (ฟรี)
1. สมัคร/Login vercel.com
2. กด "Add New Project"
3. เลือก "Browse" แล้วอัพโหลดโฟลเดอร์นี้
4. กด Deploy — ได้ URL ฟรีทันที!

หรือถ้ามี GitHub:
1. Upload ไฟล์ทั้ง 2 ขึ้น GitHub repository
2. Connect repo กับ Vercel
3. Auto-deploy ทุกครั้งที่แก้ไข

## Apps Script (เพิ่มเติม)
ต้องอัพเดทโค้ด Apps Script ให้รองรับ Sheet "Store" และ "Orders"
โค้ดเดิมที่ Deploy ไว้แล้วรองรับทุก Sheet อยู่แล้วครับ ✅
