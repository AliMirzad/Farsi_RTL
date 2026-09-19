# v1.27.0

یک ریلیز تعمیری. سه باگی که استفاده‌ی روزمره را خراب می‌کرد برطرف شد، و موتور تشخیص جهت با قاعده‌هایی بازنویسی شد که به طول کلمات و به ترتیب پردازش صفحه وابسته نیستند.

ارتقا از `v1.23.3`.

---

## باگ‌های برطرف‌شده

**پاسخ وسط نوشته‌شدن به‌هم می‌ریخت و مجبور بودی صفحه را رفرش کنی**

اکستنشن برای ایزوله‌کردن عبارت‌های لاتین، متن‌نودها را می‌شکست و با `<bdi>` جایگزین می‌کرد — حتی وقتی جواب هنوز در حال استریم بود. آن متن‌نودها را React ساخته و رفرنس مستقیم به آن‌ها نگه می‌دارد؛ به‌محض جداشدنشان، رندرِ مارک‌داون می‌مُرد و کل پاسخ به‌صورت خام (`##`، ` ``` `، `**`) در یک بلوک درهم می‌ریخت.

حالا جهت‌دهی — که فقط یک اتریبیوت و دو استایل اینلاین است و ساختار را دست نمی‌زند — بلافاصله اعمال می‌شود، ولی هر تغییر ساختاری تا وقتی پاراگراف ۴۵۰ میلی‌ثانیه ساکت بماند **و** هیچ پاسخی روی صفحه در حال تولید نباشد به تعویق می‌افتد. `<pre>` و `<code>` هم دیگر اصلاً بازساخته نمی‌شوند، چون هایلایترها مالک آن DOM هستند و مدام بازسازی‌اش می‌کنند.

**مود هوشمند موقع لود اول کار نمی‌کرد تا مود را عوض و دوباره انتخاب کنی**

حلقه‌ی پردازش `while (queue.length && deadline.timeRemaining() > 1)` بود. وقتی `requestIdleCallback` به‌خاطر تایم‌اوتش فایر می‌شود، `timeRemaining()` صفر است، پس بدنه‌ی حلقه هرگز اجرا نمی‌شد و فقط خودش را دوباره زمان‌بندی می‌کرد. هنگام بوت‌شدن ChatGPT که مرورگر وقت idle نمی‌دهد، یعنی هیچ چیز پردازش نمی‌شد. جایش بودجه‌ی زمانی واقعی با حداقل batch تضمین‌شده نشست.

یک مشکل دوم هم در همین مسیر بود: `observer.takeRecords()` که برای بلعیدن موتیشن‌های خودِ اکستنشن صدا زده می‌شد، موتیشن‌های واقعی صفحه را هم دور می‌ریخت.

**`<code>` داخل `<pre>` جهت مستقل خودش را می‌گرفت**

یعنی وقتی یک بلوک کد را دستی فلیپ می‌کردی، محتوایش می‌توانست برعکس بماند.

---

## تشخیص جهت بازنویسی شد

سؤال درست این نیست که «کدام زبان بیشترِ این پاراگراف را گرفته»، این است که «این پاراگراف به چه زبانی *نوشته* شده». نسخه‌های قبلی حروف را می‌شمردند، و این یعنی `isAnnotationPresent()` نوزده رأی برای انگلیسی بود و «متد» سه رأی برای فارسی — «متد `getClass()`» درست درمی‌آمد و «متد `isAnnotationPresent()`» برعکس، فقط چون شناسه بلندتر بود.

دو تغییر این وابستگی را حذف کرد:

**۱. کد و لینک اصلاً شمرده نمی‌شوند.** یک شناسه داخل بک‌تیک شیء خارجی‌ای است که در جمله افتاده، نه زبانی که جمله با آن نوشته شده — همان‌طور که یک شماره‌تلفن وسط پاراگراف انگلیسی آن را «عددی» نمی‌کند. در این جواب‌ها بیشترِ انگلیسی داخل بک‌تیک است، پس نثرِ باقی‌مانده معمولاً خودش گویاست.

**۲. قاعده‌هایی که به طول حساس نیستند:**

```
۱. نثر فارسی ندارد          → دست نزن
۲. نثر لاتین ندارد          → RTL
۳. نثر با فارسی شروع شده    → RTL   (همان قاعده‌ی first-strong در dir="auto")
۴. کلمات فارسی ≥ لاتین      → RTL   (کلمه، نه حرف: یک شناسه‌ی بلند یک رأی است)
۵. فارسی بین دو ران لاتین   → RTL
۶. وگرنه                    → LTR
```

قاعده‌ی پنجم پاسخِ «Compile Time و Runtime» است. یک کلمه‌ی فارسی که بین دو ران لاتین گیر کرده، شیئی نیست که جمله درباره‌اش حرف می‌زند؛ مفصلی است که جمله روی آن ساخته شده — «و» آنجا دقیقاً همان کاری را می‌کند که "and" در انگلیسی. یک زبان فقط به جمله‌ای حرف ربط می‌دهد که مالکش باشد. این *موقعیت* است، نه واژگان، پس هیچ لیست کلماتی لازم ندارد.

قاعده‌ی ششم برای نثری می‌ماند که فارسی‌اش واقعاً شیء نقل‌شده است: «The Persian word for runtime is زمان اجرا».

**CLD3 حذف شد.** روی رشته‌های کوتاه و به‌شدت مخلوط — که کل متن فنی فارسی همین است — قابل اتکا نبود، و چون async بود باعث فلیکر و صدها فراخوانی IPC وسط استریم می‌شد. سیگنال «نسبت کل صفحه» هم حذف شد، چون نتیجه را به ترتیب پردازش پاراگراف‌ها وابسته می‌کرد: یک تیتر می‌توانست در دو بار لودِ همان صفحه دو جواب مختلف بدهد. تصمیم‌گیری حالا کاملاً همگام و قطعی است.

---

## پرفورمنس

فریم‌ها در سنجش مصنوعی (۱۵۰ پاراگراف، ۲۶۰ توکن استریم) با و بدون اکستنشن یکسان‌اند: p50 و p95 هر دو روی vsync، بدون هیچ long task. مصرف CPU در پنجره‌ی استریم از ۲۲ به ۹ میلی‌ثانیه رسید (پایه‌ی بدون اکستنشن: ۱.۸).

- پاراگرافی که جهت گرفته و به اندازه‌ی کافی طولانی شده تا پایان استریم دوباره خوانده نمی‌شود؛ خواندن `textContent` در هر فریم گران‌ترین کار بود. پاراگرافی که هنوز جهت نگرفته استثناست تا چیزی وسط نوشته‌شدن بی‌جهت نماند.
- المان منجمد اصلاً وارد صف نمی‌شود. بعد از مورد بالا، تمام هزینه‌ی باقی‌مانده خودِ صف‌بندی بود، نه کار واقعی.
- امضای تغییر متن به‌جای هش‌کردن کل پاراگراف در هر توکن، طول به‌علاوه‌ی ۱۲۸ کاراکتر اول و آخر است.
- وضعیت هر المان یک آبجکت است به‌جای پنج lookup جدا.
- `<ul>` جهتش را از آیتم اولش می‌گیرد؛ خواندن کل متن لیست باعث می‌شد هر `<li>` چند بار اسکن شود.
- sweepهای ایمنی وقتی از آخرین بار هیچ موتیشنی دیده نشده باشد، اجرا نمی‌شوند.

---

## تغییرات رفتاری

- «Compile Time و Runtime» و شکل‌های مشابه حالا RTL می‌شوند (قبلاً LTR).
- `<code>` داخل `<pre>` دیگر مارک مستقل نمی‌گیرد و از `<pre>` پیروی می‌کند.
- مود هوشمند دیگر از CLD3 استفاده نمی‌کند؛ نتیجه برای یک پاراگراف مشخص همیشه یکسان است.

---

## نصب

`Farsi_RTL-v1.27.0.zip` را باز کنید، به `chrome://extensions/` بروید، **Developer mode** را روشن کنید و **Load unpacked** را روی پوشه‌ی باز‌شده بزنید.

اگر نسخه‌ی قبلی نصب است: بعد از ارتقا، اکستنشن را reload کنید و تب‌های باز ChatGPT/Claude را یک بار رفرش کنید — کد قدیمی در تب‌های باز زنده می‌ماند.

---

## English summary

A repair release, upgrading from `v1.23.3`.

**Fixed — answers collapsing mid-stream.** The extension replaced text nodes with `<bdi>` wrappers while an answer was still streaming. React owns those nodes and holds direct references to them; detaching one killed the markdown renderer and dumped the whole answer as raw markdown in a single block. Direction is still applied immediately (it only touches an attribute and two inline styles), but all structural work now waits until the paragraph has been quiet for 450ms *and* nothing on the page is generating. `<pre>`/`<code>` subtrees are never restructured.

**Fixed — smart mode doing nothing until you toggled modes.** The work loop was gated on `deadline.timeRemaining() > 1`, which is 0 whenever `requestIdleCallback` fires on its timeout, so on a busy page the loop body never ran. Replaced with a wall-clock budget and a guaranteed minimum batch.

**Fixed —** a `<code>` inside a `<pre>` no longer takes a direction of its own.

**Rewritten — direction detection.** Character ratios made the answer depend on identifier length: «متد `getClass()`» was right, «متد `isAnnotationPresent()`» was backwards. Inline code and URLs are now excluded before counting, and what remains is judged by scale-free rules: no Persian → leave alone; no Latin → RTL; starts in Persian → RTL (the first-strong rule behind `dir="auto"`); Persian words ≥ Latin words → RTL; Persian sitting *between* two Latin runs → RTL; otherwise LTR. That fifth rule is what makes "Compile Time و Runtime" right-to-left: a Persian word wedged between two Latin ones is a joint, not an object. CLD3 and the page-ratio signal were removed — the decision is now synchronous and deterministic.

**Performance.** Frame times are identical with and without the extension (p50/p95 at vsync, zero long tasks). CPU in the streaming window dropped from 22ms to 9ms against a 1.8ms no-extension baseline.
