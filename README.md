# Farsi_RTL

راست‌چین‌سازی هوشمند فارسی + فونت Vazirmatn برای ChatGPT و Claude.

Smart Persian RTL rendering + Vazirmatn font for ChatGPT and Claude.

![icon](icons/icon128.png)

## ویژگی‌ها

- 🔄 **راست‌چین هوشمند**: تشخیص کلمه‌ای زبان پاراگراف (فارسی-غالب → RTL، انگلیسی-غالب → LTR)
- 🔤 **فونت Vazirmatn** (اختیاری) در سه وزن Regular/Medium/Bold
- 🧠 **پشتیبانی از متن ترکیبی**: `<bdi>` wrapping برای هندل کردن درست پرانتز و علائم در متن دوجهته
- ⚡ **بدون کندی**: پردازش chunk-شده با `requestIdleCallback`، مناسب برای چت‌های طولانی
- 🎛️ **توگل زنده**: روشن/خاموش کردن بلافاصله بدون نیاز به رفرش
- 🔒 **حفظ حریم کاربر**: input box و پرامپت‌های تایپ‌شده دست‌نخورده می‌مونن
- 📋 **کپی تمیز**: متن کپی‌شده هیچ کاراکتر نامرئی نداره

## سایت‌های پشتیبانی‌شده

- chatgpt.com
- chat.openai.com
- claude.ai

## نصب دستی (Load unpacked)

1. برو به `chrome://extensions/`
2. **Developer mode** رو بالا-راست فعال کن
3. **Load unpacked** رو بزن و پوشه اکستنشن رو انتخاب کن

## استفاده

روی آیکون سبز حرف «ف» توی نوار مرورگر کلیک کن. دو سوییچ داری:

- **راست‌چین**: چیدمان RTL هوشمند
- **فونت Vazir**: تعویض فونت به Vazirmatn

## مجوز

MIT

## Contributing

PRها و issueها استقبال میشن.
