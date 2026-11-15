# Urban Crisis & Crowd Evacuation Engine — Texniki izah

Fövqəladə hallarda (zəlzələ, sel, sənaye qəzası, kütləvi tədbir) vətəndaşa təhlükəsiz toplanış məntəqəsini və təxliyyə marşrutunu göstərən, dispetçerə isə SOS axınını emal edib bir kliklə qərar verməyə imkan verən mikro-sistem.

## 1. Problem
Böhran anında yollar bağlanır, panika nəticəsində çıxışlarda tıxac yaranır. Vətəndaş ən yaxın məntəqənin nə qədər dolu olduğunu və hansı yolun bağlı olduğunu görmür. Dispetçer isə çoxsaylı SOS-u əl ilə emal etməli olur. Əlavə risk: **saxta SOS** axını real həyəcanı gizlədə və ya ehtiyatları boşuna səfərbər edə bilər.

## 2. Tələblər və onların qarşılanması

| Tələb | Necə qarşılanır | Harada |
|---|---|---|
| Ən yaxın məntəqələr, doluluq %, marşrut | `/api/evacuation`, mobil "Marşrut" ekranı | `evacuation.js`, `routing.js` |
| Bir kliklə SOS (4 növ) + "Təhlükəsizəm" | Mobil ana ekran; SOS 3 san. ləğv oluna bilən geri sayımla; "Təhlükəsizəm" basıb saxlama + sürüşdürmə ilə | `public/mobile.html` |
| Yol bağlananda / məntəqə ≥90% olanda avtomatik alternativ | Marşrutlaşdırma bağlı yolu atlayır; ≥90% məntəqə "dolu" sayılır; səbəb vətəndaşa yazılır | `evacuation.js` |
| Canlı dispetçer paneli | SSE axını, xəritə, məntəqələr, briqadalar, SOS lenti | `public/dispatcher.html` |
| Kritik Böhran Alqoritmi (500 m / 5 dəq / 4 fərqli SOS və ya >95%) | Qırmızı həyəcan + bir klik təsdiq | `crisis.js` |
| "Əlavə Xilasetmə Briqadası Göndər və Yeni Toplanış Nöqtəsi Aç" | `approve()`: ən yaxın azad briqada + ən yaxın ehtiyat məntəqə | `crisis.js` |
| Dinamik şərtlər (yeni rol/dil, API kəsintisi, yüksək yük, təhlükəsizlik) | Bax: [Challenge Drop hazırlığı](#challenge-drop-hazırlığı) | |

## 3. Həllin icmalı
İki modul eyni xidmətdə işləyir:
- **Vətəndaş (mobil PWA)** `/`: sakit ana ekran ("Nə baş verir?") → SOS növünü seç → 3 saniyəlik ləğv edilə bilən geri sayım → "SOS göndərildi" ekranı (dispetçerə çatdı → briqada təyin olunur → yardım yoldadır + ETA). Marşrut və xəritə ayrıca ekrandadır. Offline olanda SOS telefonda saxlanılır və şəbəkə gələndə göndərilir.
- **Dispetçer** `/dispatcher`: həyəcanlar kritikdən başlayaraq sıralanır. Təsdiqdən **əvvəl** nə olacağı yazılır ("Rescue-1 göndərilir, çatma ~4 dəq; Nəsimi məktəbi açılır"). Təsdiqdən sonra 10 saniyə geri qaytarmaq olar.

## 4. Arxitektura və texnologiya seçimləri
```
public/ (vanilla JS + Leaflet)  ──HTTP / SSE──▶  src/app.js (marşrutlar, auth, limitlər)
                                                   ├─ store.js        vəziyyət + hadisələr
                                                   ├─ crisis.js       qayda mühərriki (konfiqurasiya əsaslı)
                                                   ├─ abuse.js        saxta SOS müdafiəsi (trust.js, botdetect.js, net.js, session.js)
                                                   ├─ evacuation.js   sıralama + yenidən marşrut səbəbləri
                                                   ├─ routing.js      yol qrafı + 3 pilləli ehtiyat
                                                   ├─ history.js      zaman maşını kadrları
                                                   ├─ scenarios.js    demo ssenariləri
                                                   └─ openapi.js      API təsviri (/api/docs)
```
- **Node.js ≥ 20, asılılıqsız.** `npm install` lazım deyil; yarışda internet/şəbəkə problemi riski sıfırdır. Test üçün daxili `node:test`.
- **SSE** (WebSocket əvəzinə): yalnız server→brauzer axını lazımdır, avtomatik yenidən qoşulur, proxy-lərdən asan keçir. Yeniləmələr 150 ms ərzində birləşdirilir (flood zamanı yük artmasın).
- **Yaddaşda saxlama.** `Store` yeganə keçid nöqtəsidir, DB-yə köçürmək ayrıca modul dəyişikliyi tələb etmir. Restartda vəziyyət sıfırlanır (bax: məhdudiyyətlər).
- **Simulyasiya olunmuş xarici xəritə API-si.** `RoutingService`: xarici (canlı tıxac əmsallı, 700 ms timeout) → lokal qraf (statik məsafə, bağlı yolları yenə nəzərə alır) → "marşrut yoxdur" (məntəqə əlçatmaz kimi işarələnir).

## 5. Alqoritmlər

### 5.1 Kritik Böhran Alqoritmi (`crisis.js`)
- **Qayda A:** son 5 dəqiqədə **≥4 fərqli** şəxsdən SOS, eyni rayon daxilində **və ya** bir-birindən 500 m radiusda. Fərqlilik cihaz kimliyi ilə ölçülür (eyni şəxsin təkrar SOS-u 1 sayılır).
- **Qayda B:** məntəqə doluluğu **>95%** (dəqiq 95% həyəcan yaratmır).
- Hər ikisi qırmızı həyəcan yaradır: *"Qırmızı Həyəcan: Əlavə Xilasetmə Briqadası Göndər və Yeni Toplanış Nöqtəsi Aç"*.
- **Təkrarsızlıq:** böyüyən klaster mövcud həyəcanı yeniləyir. Təsdiqlənmiş həyəcanın **əhatə etdiyi SOS-lar yeni dəlil sayılmır**: göndərişdən sonra gələn 1-2 SOS təkrar həyəcan yaratmır, lakin 4 yeni şəxsin SOS-u yeni hadisədir.
- **Performans:** yeni SOS gələndə yalnız onun ətrafı və rayonu yenidən qiymətləndirilir (O(pəncərə), O(pəncərə²) deyil). İlk versiyada hər SOS bütün pəncərəni skan edirdi: yük testində p95 ≈ 960 ms idi, düzəlişdən sonra ≈ 12 ms.
- **Təsdiq:** ən yaxın azad briqada göndərilir + ən yaxın ehtiyat məntəqə açılır. Əməliyyat idempotentdir. `plan()` eyni qərarı **əvvəlcədən** göstərir və test təsdiq edir ki, `approve()` tam olaraq `plan()`-ın vəd etdiyini edir. 10 saniyə ərzində `undo()` mümkündür.

### 5.2 Marşrutlaşdırma və yenidən marşrut (`routing.js`, `evacuation.js`)
Yol şəbəkəsi sintetikdir: rayon və məntəqə mərkəzlərindən minimal örtük ağacı (bağlılığı zəmanət verir) + hər nöqtə üçün ən yaxın 3 qonşu (ehtiyat yollar). Dijkstra bağlı yolları atlayır, canlı tıxac əmsalını çəkiyə vurur. Vətəndaşın ətrafındakı 5 məntəqə üçün marşrut hesablanır. "Dolu" (≥90%) və ya əlçatmaz olanlar tövsiyədən çıxarılır, yenidən marşrut səbəbi (`POINT_FULL`, `ROAD_BLOCKED`, `POINT_FILLING_FAST`) vətəndaşa göstərilir.

### 5.3 Proaktiv proqnoz (`store.js`, `crisis.js`, `evacuation.js`)
Hər məntəqə üçün son 5 dəqiqənin nümunələrindən **dolma sürəti** (nəfər/dəq) hesablanır (ən azı 60 san. məlumat tələb olunur). Cari sürətlə 10 dəqiqə ərzində 95%-ə çatacaqsa, **95%-dən əvvəl** amber xəbərdarlıq yaranır ("~4 dəq-dən sonra 95%-i keçəcək"). Təsdiq yalnız ehtiyat məntəqəni açır (briqada göndərmir). Doluluq 95%-i keçəndə amber qırmızı ilə əvəzlənir. Vətəndaş tərəfdə: yaxın görünən, amma **vətəndaş çatanda dolacaq** məntəqə (`projectedPct ≥ 90%`) tövsiyədə geri salınır.

### 5.4 Saxta siqnal müdafiəsi (`abuse.js`, `trust.js`, `botdetect.js`, `session.js`, `net.js`)
Əsas prinsip: **şübhəli SOS heç vaxt silinmir və rədd edilmir.** O yalnız avtomatik həyəcan sayına daxil edilmir, dispetçerə "şübhəli" işarəsi ilə çatır və bir klikləmə ilə "Burax" oluna bilər. Canlı təhlükədə olan adamın SOS-u sistem səhvi üzündən itməməlidir.

| Mexanizm | Nə edir |
|---|---|
| **İmzalı cihaz sessiyası** | `/api/session` HMAC-SHA256 imzalı kimlik verir (IP üzrə sürət limiti ilə). İmzalı SOS-un kimliyi tokendən götürülür, body-dən yox. Token olmayan və ya saxta token olan SOS **yenə qəbul olunur**, sadəcə "təsdiqsiz" sayılır. |
| **Cihaz etibarı (trust)** | Yeni/təsdiqsiz cihazın çəkisi aşağıdır; karantinə düşən cihazın etibarı azalır, həyəcanda iştirak edən (təsdiqlənmiş) cihazın artır. |
| **Bot aşkarlama** | Son 5 dəqiqədə siqnallar: ani sıçrayış, **bir IP-dən 6+ cihaz**, maşın kimi bərabər interval, yeni cihaz payı. **Hücum** = ≥2 siqnal **və** təqsirkar kimi göstərilə bilən ən azı bir mənbə. |
| **Real kütləvi hadisədən fərq** | Həqiqi fəlakətdə SOS sıçrayışı və yeni cihazlar da olur. Təqsirkar yalnız IP təmərküzü ilə göstərildiyi üçün, çoxlu fərqli IP-dən sıçrayış "artım" (`surge`) kimi qeyd olunur, **heç kim karantinə düşmür**. |
| **İstisnalar** | Loopback/şəxsi/proxy ünvanları IP təhlilinə daxil edilmir (LAN demo, docker, yerli yük testi). İmzalı, ≥2 dəq köhnə, etibarlı cihazlar ortaq IP (NAT, stadion Wi-Fi) səbəbindən şübhəli sayılmır. `X-Forwarded-For` yalnız `TRUST_PROXY=1` olanda oxunur. |
| **Coğrafi yoxlama** | Bütün rayon mərkəzlərindən 25 km-dən uzaq koordinat `out_of_area` kimi işarələnir və həyəcana daxil edilmir. Dəqiqlik (accuracy) yoxdursa (rayon əl ilə seçilib) SOS cəzalandırılmır. |
| **Geri çəkilmə** | Həyəcan yarandıqdan sonra dəlilləri karantinə düşərsə, həyəcan özü-özünə çəkilir. |
| **Təhlükəsizlik rejimi** | `requireVerified=true`: yalnız imzalı cihazların SOS-u avtomatik həyəcana sayılır. İş vaxtı bir düymə ilə açılır. |

Etibarlı kompromis: əgər təhlükəli bir saxtakar çoxlu real IP-dən təsdiqli cihaz yaradıb 2 dəqiqə gözləsə, bu müdafiəni keçə bilər. Bu prototipin açıq məhdudiyyətidir (bax: 9).

### 5.5 Qayda sabitliyi
- **Histerezis:** qırmızı doluluq həyəcanı yalnız doluluq **<90%** olanda bağlanır (95%-ə yaxın yanıb-sönmə yoxdur).
- **Cooldown:** təsdiqdən sonra eyni məntəqə üçün 5 dəqiqə yeni həyəcan yaranmır, **98%-ə** çatmasa.

### 5.6 Prioritet SOS rolu və əlçatan təxliyyə (`priority.js`, `routing.js`, `evacuation.js`, `crisis.js`)
**Rol.** İki vətəndaş rolu var: `citizen` və `priority` (hərəkət məhdudiyyətli / xüsusi qayğıya ehtiyacı olan şəxs). Ehtiyaclar: `wheelchair` (əlil arabası), `reduced_mobility` (çətin yeriyir), `medical_transport` (tibbi nəqliyyat). Rol **imzalı cihaza** bağlıdır (`POST /api/profile`, `X-Device-Token` tələb olunur); imzasız cihaz prioritet iddia edə bilməz. Ehtiyac bəyanı SOS ilə birlikdə də gedə bilər (offline növbə üçün), səhv/zibil dəyər **heç vaxt SOS-u rədd etmir**, sadəcə atılır.

**Avtomatik Kritik Prioritet #1.** Prioritet rollu cihazın hər SOS-u `priority = 1` alır və `PRIORITY_SOS` həyəcanı **dərhal** yaranır: "4 nəfər" qaydası tətbiq olunmur, bir SOS kifayətdir. Həyəcan dispetçer siyahısında hər şeydən üstdə göstərilir. Şəxs SOS-u ləğv edərsə, "Təhlükəsizəm" basarsa və ya SOS karantinə düşərsə (məs., ərazidən kənar koordinat) həyəcan çəkilir. Karantindəki SOS dispetçer "Burax" edəndən sonra yenidən işə düşür.

**Əlçatan marşrut.** Hər məntəqənin `accessible` (pandus / pilləsiz giriş) və `access` (pandus, lift, geniş qapı, əlçatan tualet) xüsusiyyətləri var. Hər yol seqmentinin `stepFree` bayrağı var (simulyasiyada seqmentlərin ~14%-i pilləli/sıldırım sayılır; dispetçer bunu `POST /api/roads/:id/accessibility` ilə dəyişə bilər). Əlçatan rejimdə (prioritet rollu imzalı cihaz üçün avtomatik, və ya `?accessible=1`):
- yalnız `accessible` məntəqələr təklif olunur;
- Dijkstra yalnız `stepFree` seqmentlərlə gedir (xarici API və lokal ehtiyat marşrutlaşdırma eyni qaydanı bilir);
- ən yaxın məntəqədə pandus yoxdursa, səbəb `NOT_ACCESSIBLE` kimi yazılır;
- pilləsiz marşrutla heç bir məntəqəyə çatmaq mümkün deyilsə, `noAccessibleRoute` + `needsTransport` qaytarılır, nəqliyyat vətəndaşın yerinə gəlir.

**Nəqliyyat təyinatı.** Təsdiqdə ən yaxın azad **əlçatan nəqliyyat** (`accessible_transport`, lift/pandus avtomobili) göndərilir; azad yoxdursa ən yaxın tibbi briqada **işarələnmiş ehtiyat** kimi seçilir (dispetçerə yazılır), heç biri yoxdursa təsdiq xəta vermir və "azad nəqliyyat yoxdur" göstərilir. Ehtiyat məntəqə açılmır. `plan()` bunu təsdiqdən əvvəl göstərir; testlər `approve()`-un `plan()`-a uyğunluğunu yoxlayır.

**Etibar məsələsi.** Rol özü-bəyandır (əlilliyi sistem yoxlaya bilməz). Sui-istifadə riskini azaldan: yalnız imzalı cihaz, eyni karantin/bot müdafiəsi, dispetçerə "özü bəyan edib" yazılması. Real yerləşdirmədə rolun sosial müdafiə reyestri ilə təsdiqi əlavə edilə bilər.

### 5.7 Briqada həyat dövrü (`crisis.js`, `store.js`)
Təsdiqdən sonra briqada "göndərilir" statusunda donub qalmır: `dispatched` (xəritədə baza → hadisə yerinə hərəkət, canlı ETA geri sayımı və irəliləmə zolağı) → `on_scene` (hadisə yerində, `onSceneMs`) → `returning` (geri hərəkət) → `available`. Gediş vaxtı məsafə / sürət əsasında hesablanır. Mövqe vaxta görə interpolyasiya olunur (store-da yalnız hərəkətin başlanğıcı və müddəti saxlanır), ona görə snapshot istənilən anda dəqiq mövqe verir. Qayıdan briqada yeni tapşırıq üçün azad sayılmır. Geri qaytarma (`undo`) briqadanı bazaya qaytarır. `brigadeTimeScale` qaydası (dispetçer panelində x1/x5/x10/x30) bütün missiyanı demo üçün sürətləndirir. Vətəndaş ekranında addımlar: dispetçerə çatdı → briqada təyin olunur → yardım yoldadır **(canlı ETA)** → yardım yerindədir. Zaman maşını kadrlarına briqada mövqeləri də yazılır.

### 5.8 Qərar jurnalı (`audit.js`)
Dispetçerin hər qərarı (təsdiq, geri qaytarma, SOS buraxma, yol, briqada statusu, bildiriş, admin əməliyyatları) və sistemin həyəcan yaratması jurnala düşür: kim (rol), nə vaxt, nəyi, hansı nəticə ilə. Jurnalda **IP, token və vətəndaş kimliyi yoxdur** (testlə yoxlanılır), buna görə dispetçer panelində göstərilə bilir. Uğursuz (rədd edilən) cəhdlər qərar kimi yazılmır. `GET /api/decisions` və dashboard snapshot-ı son qərarları verir.

### 5.9 Dispetçerdən kütləvi bildiriş (`broadcast.js`)
Dispetçer vətəndaşlara **təxliyyə** (xüsusi məntəqəyə köçün), **sığınma**, **ərazidən uzaq durun**, **təhlükə sona çatdı** və ya **fərdi mətn** göndərir. Hədəf: bütün şəhər, rayon və ya radius (həyəcan ətrafı). Bildiriş vətəndaşın dilində şablondan yaranır (fərdi mətn üçün az/en/ru sahələri). Tətbiq 5 saniyədən bir öz koordinatı ilə sorğu edir (pull modeli), **server vətəndaşın yerini saxlamır**. Kritik bildiriş (təxliyyə) tam ekran pəncərə kimi çıxır və SOS geri sayımını örtmür. Digərləri ana ekranda banner kimi görünür, "Oxudum" düyməsi var. **Əlçatan istifadəçi** (prioritet rol) üçün pandussuz məntəqə avtomatik ən yaxın əlçatan məntəqə ilə əvəz olunur. "Təhlükə sona çatdı" əhatə etdiyi xəbərdarlıqları ləğv edir (rayon üzrə olan şəhər miqyaslı xəbərdarlığı ləğv etmir). Dispetçerdə hər bildiriş üçün "çatdı" (sorğu edən fərqli cihaz) və "oxudu" sayğacları var, aktiv bildiriş geri çəkilə bilər.

### 5.10 SMS ehtiyatı (`sms.js`)
İnternet olmayanda vətəndaş qısa nömrəyə SMS göndərir, gateway (burada simulyasiya) `POST /api/sms/inbound` webhook-unu çağırır (`X-Gateway-Key` tələb olunur) və cavab mətnini qaytarır. Komandalar (diakritikasız/böyük-kiçik hərfə həssas deyil, az və ya en): `SOS [növ] [ehtiyac] <rayon | lat,lng>`, `TEHLUKESIZEM`, `YER <rayon>`. Növ verilməsə tibbi sayılır, yer başa düşülməsə cavabla soruşulur. Əlil arabası kimi ehtiyac sözləri SOS-u Kritik Prioritet #1 edir. **Telefon nömrəsi heç yerdə saxlanılmır**: yalnız duzlu hash anonim identifikator kimi işlədilir (eyni nömrə həmişə eyni id). Nömrə üzrə sürət limiti var (dəqiqədə 3). SMS ilə gələn SOS təsdiqli sayılır, gateway ünvanı bot "IP təmərküzü" kimi qiymətləndirilmir. Mobil tətbiq offline olanda növ düymələri ilə **hazır doldurulmuş `sms:` linkləri** göstərir (mətndə cari koordinat var).

### 5.11 Zaman maşını (`history.js`)
Hadisə zamanı (1 san. ərzində bir dəfə) və hər 5 saniyədən bir kompakt kadr yazılır: məntəqə doluluqları, SOS koordinatları (kadra ≤150), həyəcanlar, briqadalar, bağlı yollar. İdentifikatorlar kadra düşmür. Dispetçer son 2 saatı sürüşdürə və ya oynada, "həyəcan necə yarandı" göstərə bilər.

## 6. İstifadəçi interfeysi
Dizayn istiqaməti: DevLink-in təmiz dili (`#0071e3`, Plus Jakarta Sans/Inter, yumşaq künclər). Qərarlar:
- **Təsadüfi toxunuş riski:** "Təhlükəsizəm" SOS düymələrindən ən uzaq nöqtədədir və **basıb saxlamaqla** (1,5 san.) + sürüşdürmə ilə təsdiqlənir, çünki təsadüfən basılsa açıq SOS bağlanar. Sürüşdürə bilməyənlər üçün 2 saniyə basıb saxlama alternativi, klaviatura ilə Enter/Space var.
- SOS düymələri başparmaq zonasındadır; geri sayım və 60 saniyəlik "Səhv göndərdim" ləğvi var.
- Mətnlər sadədir: təhlükədə olan adama reklam tonu yoxdur.
- **Dil (i18n):** az / en (+ ru); bütün UI, xəta mesajları, ARIA etiketləri, giriş pəncərəsi, simulyasiya düymələri, məntəqə və rayon adları açarlarla gəlir və səhifə yenilənmədən dəyişir. Testlər: az/en açar dəstinin eyniliyi, UI fayllarında hardcoded Azərbaycan/kiril mətninin olmaması, UI-da işlədilən hər açarın lüğətdə olması, hər enum dəyərinin (SOS növü, ehtiyac, əlçatanlıq xüsusiyyəti, səbəb və s.) tərcüməsi, serverin atdığı hər xəta kodunun tərcüməsi. Yeni dil = `i18n-ext.js`-də bir obyekt.
- Dispetçer: təsdiqdən əvvəl nəticə önbaxışı, 10 san. geri qaytarma, karantin siyahısı + "Burax", hücum/artım xəbərdarlığı, ssenari paneli, zaman maşını.

## 7. Keyfiyyət və test
- **352 açar/dil, 144 avtomatik test** (`npm test`, ~0,5 san.): alqoritm sərhəd halları (dəqiq 95%, eyni şəxsin təkrar SOS-u, 5 dəqiqədən köhnə SOS), idempotentlik, geri qaytarma, marşrut ehtiyatı, auth/rollar, sürət limiti, saxta SOS ssenariləri, real kütləvi hadisədə heç kimin bloklanmaması, OpenAPI ilə real marşrut cədvəlinin uyğunluğu, dillərin eyni açar dəstinə malik olması.
- **Yük testi** (`npm run load`, lokal, 50 paralel, SOS + təxliyyə sorğusu qarışığı): ~5 000+ sorğu/san., p95 ≈ 16 ms.
- Dispetçer paneli real Chrome-da (başsız rejim) ssenarilərlə yoxlanılıb. Mobil ana ekran render yoxlanılıb; geri sayım, "göndərildi" və təsdiq ekranlarının əl ilə klik testi aparılmayıb.
- `Dockerfile` və `docker-compose.yml` hazırdır; image-in tərkibi və healthcheck əmri təmiz qovluqda əl ilə təkrarlanıb, lakin bu maşında Docker daemon işləmədiyi üçün **image real build edilməyib**.

## 8. Təhlükəsizlik və məxfilik
- Rol/icazə modeli (`auth.js`): vətəndaş, müşahidəçi (oxu), dispetçer, admin. Token müqayisəsi `timingSafeEqual` ilə.
- Giriş yoxlaması (SOS növü, koordinat, ölçü), 16 KB sorğu limiti, sürət limitləri (SOS, sessiya, ümumi), statik fayllarda path-traversal qoruması, UI-da HTML escape.
- **Məxfilik:** dispetçer paneli və tarixçə kadrları IP, cihaz və vətəndaş identifikatorlarını **daşımır** (testlə yoxlanılır). Not sahəsi 280 simvolla məhdudlaşıb.
- Demo tokenləri (`admin-demo` və s.) yalnız demo üçündür. `NODE_ENV=production` və defolt token olduqda server xəbərdarlıq yazır. Real yerləşdirmədə `ADMIN_TOKEN`, `DISPATCHER_TOKEN`, `TOKEN_SECRET` dəyişdirilməlidir.

## Challenge Drop hazırlığı

| Dəyişiklik | Necə həll olunur |
|---|---|
| **Yeni rol: Prioritet SOS (hərəkət məhdudiyyətli)** | `priority.js` + `POST /api/profile`. Avtomatik Kritik Prioritet #1, əlçatan marşrut, əlçatan nəqliyyat (5.6). Ssenari: `priority_sos` |
| Personal (dispetçer) rolu | `auth.js` → `ROLE_PERMISSIONS` + token (`observer` artıq nümunədir) |
| UI-ın az/en dinamik dəyişməsi, yeni dil | `i18n-ext.js` → bir obyekt. Səhifə yenilənmədən dəyişir, test hər açarı yoxlayır |
| Xarici API kəsintisi/yavaşlığı | Avtomatik ehtiyat marşrut, vətəndaşa bildirilir. Ssenari: `api_outage` |
| Yüksək yük | Sürət limitləri, fokuslu qiymətləndirmə, SSE birləşdirmə, flood zamanı təhlil throttle. Ssenari: `fake_flood`, `mass_event` |
| Təhlükəsizlik tələbi | İmzalı sessiyalar, "Təhlükəsizlik rejimi" (`requireVerified`) iş vaxtı bir düymə ilə, rol/icazə |
| Dispetçerdən kütləvi bildiriş / SMS ehtiyatı / qərar jurnalı | `broadcast.js`, `sms.js`, `audit.js` (5.8 – 5.10). Ssenarilər: `broadcast_demo`, `sms_sos` |
| Yeni hədd/qayda | `POST /api/sim/rules` (açar və tip yoxlanılır) |
| Yeni SOS növü | `SOS_TYPES` (`store.js`) + `sos.*` açarları |

## 9. Məhdudiyyətlər
- Vəziyyət yaddaşdadır, restartda sıfırlanır (bir instans). `TOKEN_SECRET` verilməsə, imzalı sessiyalar restartdan sonra yenidən alınır.
- Yol şəbəkəsi sintetikdir (real küçələr deyil), marşrut qraf düyünləri arasında düz seqmentlərdir. ETA piyada sürəti (80 m/dəq) və briqada üçün ~36 km/s ilə təxmin edilir.
- Əlçatanlıq məlumatı (məntəqələrdə pandus/lift, yol seqmentlərində pilləsizlik) simulyasiyadır, real sidewalk məlumatı yoxdur. Əlçatan marşrutun ETA-sı piyada sürəti ilə təxmin edilir. Prioritet rol özü-bəyandır.
- Cihaz kimliyi telefon/OTP ilə bağlı deyil. Saxtakar ayrı IP-lərdən çoxlu imzalı cihaz yaradıb gözləyərsə, müdafiəni keçə bilər. IP əsaslı təhlil CGNAT arxasında zəifdir (buna görə təqsirkar yalnız imzasız və ya yeni cihazlar sayılır).
- Xəritə plitələri OpenStreetMap-dən yüklənir (internetsiz xəritə fonu boş görünür, marşrutlar və məntəqələr isə çəkilir). Leaflet lokaldır.
- SMS gateway simulyasiyadır (real operator inteqrasiyası yoxdur). SMS-də yer (rayon və ya koordinat) verilməsə SOS yaradılmır, cavabla yer soruşulur. Kütləvi bildiriş "pull" modelidir: tətbiq açıq olmayanda push bildirişi göndərilmir (real yerləşdirmədə Web Push/FCM lazımdır).
- Dolma sürəti xətti ekstrapolyasiyadır. Qəfil dəyişikliklərdə (axın dayanması) proqnoz gec yenilənir (5 dəqiqəlik pəncərə).

## 10. Gələcək inkişaf
Daimi yaddaş (JSON snapshot → DB), real küçə şəbəkəsi (OSM/rəsmi açıq məlumat), telefon nömrəsi/OTP ilə cihaz təsdiqi, çoxlu instans üçün paylanmış hadisə kanalı, dispetçer qərarlarının audit jurnalı.
