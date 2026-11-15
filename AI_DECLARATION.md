# AI İstifadəsi haqqında Bəyannamə

Urban Crisis & Crowd Evacuation Engine  ·  Hakaton, 15 noyabr 2026


## 1. Ümumi məlumat


| Məsələ | Məlumat |
|---|---|
| Layihə | Urban Crisis & Crowd Evacuation Engine: vətəndaş təhlükəsizlik tətbiqi (mobil PWA) və dispetçer paneli ilə Kritik Böhran Alqoritmi |
| İş müddəti | 4 saatlıq hakaton, ilk commit 11:24, son commit 14:36 (git tarixçəsində 17 commit) |
| Əsas AI aləti | **Claude Code** (Anthropic), terminalda işləyən kodlaşdırma agenti. Sessiya boyu Claude modelləri, o cümlədən Claude Sonnet 5.5 işlədilib |
| Köməkçi alətlər | Claude Code-un daxilindəki "superpowers" bacarıq paketi (iş axını qaydaları: planlaşdırma, test-əvvəl yanaşma, yoxlama); dizayn variantlarını göstərmək üçün Claude Artifact (HTML səhifə) |
| İstifadə olunmayan alətlər | Cursor, GitHub Copilot və ChatGPT bu layihədə istifadə edilməyib |
| İnsan məsuliyyəti | Tələbləri, prioritetləri, dizayn seçimini və hər addımın qəbulunu komanda verib. AI yazılan kodun və sənədlərin müəllifi deyil, komandanın tapşırığı ilə işləyən icraçı olub |


## 2. Necə işlədik

Komanda ilə Claude Code arasında **davamlı söhbət (dialoq)** formatında işlədik. Hər mərhələdə insan nəyi istədiyini deyib (çox vaxt qısa və konkret: "bunu push et", "xəritə açılmır", "bu ifadə qeyri-peşəkardır"), AI təklif və icra edib, nəticəni isə insan özü brauzerdə və telefonda baxıb, qəbul edib və ya geri qaytarıb.

Təkrarlanan dövr belə idi:

- **Tələb:** insan tapşırığı və ya şikayəti verir (çox vaxt ekran görüntüsü ilə).
- **Təklif:** AI variantları və tövsiyəsini yazır, vacib seçimdə insandan soruşur.
- **İcra:** AI kodu, testi və sənədi yazır.
- **Yoxlama:** AI avtomatik testləri və real brauzer yoxlamasını işlədir, nəticəni olduğu kimi bildirir; insan öz gözü ilə baxır.
- **Qəbul:** yalnız insan "push et" dedikdə commit və push edilir.

## 3. Mərhələlər üzrə AI-nin rolu


| Mərhələ | AI nə etdi | İnsan nə etdi / qərar verdi | Necə yoxlandı |
|---|---|---|---|
| İlkin arxitektura (11:24) | Asılılıqsız Node.js xidməti: yaddaş anbarı, marşrutlaşdırma, böhran qaydaları mühərriki, API, ilk dispetçer UI | Tapşırığı, qiymətləndirmə meyarlarını və prioriteti verdi; arxitekturanı nəzərdən keçirdi | İlk 32 avtomatik test, npm test |
| Mobil tətbiq (11:31) | /mobile PWA: oflayn SOS növbəsi, xəritə, marşrut | **İdeyanı insan verdi:** "SOS vaxtı heç kim kompüterdə veb interfeys açmayacaq, /mobile yaradaq" | Telefon ölçüsündə brauzerdə baxış; xəritə açılmama xətası insanın ekran görüntüsü ilə tapıldı və düzəldildi |
| Dizayn (11:56) | 5 dizayn istiqaməti ilə Artifact hazırladı; seçilən istiqaməti dəqiqləşdirdi və koda tətbiq etdi | **Dizaynı insan seçdi** (komandanın əvvəlki layihələrindən ilhamlanan istiqamət). "Təhlükəsizəm" düyməsinin təsadüfən basılması, "Ana ekran" mətninin reklam kimi görünməsi kimi rəyləri verdi, AI yenidən işlədi | İnsan hər variantı ekranda gördü və rəy verdi |
| Saxta SOS müqaviməti, proqnoz, ssenarilər (12:14) | Cihaz imzası, etibar balı, bot aşkarlama, karantin, OpenAPI sənədi, Docker, texniki izah | İnsan yoldaşın repozitoriyası ilə müqayisə etdirdi və yararlı olanları seçdi | Hücum ssenarisi testləri, sərhəd halları |
| Challenge Drop 1 (12:23) | Prioritet SOS rolu (Kritik #1), yalnız əlçatan marşrut və nəqliyyat, AZ/EN/RU i18n | Tələbi verdi; dil dəyişməsinin səhifəni yeniləmədən işləməsini yoxladı | Testlər: backend prioriteti müştəri dəyişə bilmir; yalnız əlçatan marşrut; tərcümə açarlarının eyniliyi |
| Məhsul boşluqları (12:54) | Briqada həyat dövrü, kütləvi bildiriş, qərar jurnalı, SMS ehtiyatı | İnsan "səncə başqa hansı funksiyalar olmalıdır" deyə soruşdu, AI təklif etdi, insan "hamısını et" dedi | Hər funksiya üçün test |
| Briqada seçimi (13:07) | Növə görə təklif + dispetçerin əl ilə seçimi | İnsan "dispetçer briqadanı necə təyin edir" sualı ilə boşluğu özü tapdı | Testlər və dispetçer panelində canlı yoxlama |
| Challenge Drop 2 (13:22) | Dövrə kəsici (circuit breaker), 3 pilləli yerli ehtiyat (yaddaş, statik matris, yerli qraf), "Oflayn / Ehtiyat marşrut rejimində işləyir" bildirişi | Mətnin tapşırıqdakı kimi olmasını tələb etdi | 503, yavaşlıq, bərpa testləri; brauzerdə kəsilmə və bərpa ssenarisi |
| Tək SOS-a briqada (13:37) | Paneldən briqada təyini, vətəndaş cihazında canlı addım yenilənməsi | İnsan "paneldən dispetçer briqada verə bilsin, istifadəçi cihazında addım yenilənsin" dedi | İki real brauzer tabı: biri vətəndaş, biri dispetçer; tam dövrə yoxlandı |
| Challenge Drop 3 (14:12) | Sürət limiti, dublikat filtri, axın (flood) rejimi, JWT və rol əsaslı giriş, gecikmə testi | Tələbi verdi; səhv göründüyü yerləri (xəritə kafelləri, giriş) ekran görüntüsü ilə bildirdi | 600 SOS testi, orta gecikmə 300 ms-dən aşağı (yerli ölçmədə təxminən 5 ms), 401/403 testləri |
| UX cilası (14:17 – 14:36) | Marşrut xidməti adlandırması, tablı panellər, tam ekran düzəni, "Aktiv SOS" kartı, "SOS yoxdur" paneli, qalıcı giriş açarları | İnsan qeyri-peşəkar ifadələri ("xarici API işləyir") göstərdi, düzəni referans şəkli ilə təyin etdi, giriş məsələsini (hər yeniləmədə parol) şikayət etdi | Hər dəyişiklik real brauzerdə yoxlandı və yalnız insan təsdiqindən sonra push edildi |


## 4. Challenge Drop həllərində AI-nin payı

- **Drop 1 (Prioritet SOS və dil):** AI prioritet qaydasını backend-də tətbiq etdi, müştəridən gələn dəyər nəzərə alınmır. İnsan tələbləri və qəbul meyarını verdi, dil keçidini özü sınadı.
- **Drop 2 (xarici marşrut API nasazlığı):** AI dövrə kəsici və ehtiyat pillələrini yazdı. Real xarici xidmət qoşulmayıb, nasazlıq simulyasiya olunur (panelin "Simulyasiya" bölməsi); bunu hesabatda açıq yazırıq. Qoruma qatları real xidmətə qoşulanda dəyişmədən işləyəcək.
- **Drop 3 (SOS axını, JWT, gecikmə):** AI qorumanı və testləri yazdı. İmza açarı olaraq ortaq gizli söz əvəzinə Ed25519 açar cütü seçildi; açarlar ilk başlanğıcda avtomatik yaranır və gizli faylda saxlanılır, heç bir parol və ya açar kodda və repozitoriyada yoxdur.

## 5. AI-nin səhvləri və necə tapıldı

AI-nin çıxışı olduğu kimi qəbul edilmədi. Sessiya boyu real səhvlər çıxdı və düzəldildi:


| Səhv | Necə tapıldı | Düzəliş |
|---|---|---|
| Böhran qaydası hər SOS-da bütün pəncərəni yenidən hesablayırdı (O(n²)); yük testində p95 təxminən 960 ms | npm run load yük testi | Yalnız yeni SOS ətrafında qiymətləndirmə; p95 təxminən 12 ms |
| Mobil xəritə açılmırdı (Leaflet yüklənmirdi) | İnsan ekran görüntüsü göndərdi | Leaflet yerli qovluğa köçürüldü |
| Tarixçə rejimində xəritə canlı yenilənmirdi | İnsanın şikayəti | Canlıya avtomatik qayıdış və yenilənmə |
| Drop 3-də əlavə etdiyimiz Referrer-Policy: no-referrer OpenStreetMap kafellərini bloklatdı (403) | İnsan ekran görüntüsü göndərdi | strict-origin-when-cross-origin + bunu yoxlayan test |
| "Bura gedirəm" düyməsini təkrar-təkrar basmaq olurdu | İnsanın ekran görüntüsü | Bir dəfəlik düymə |
| Dispetçer hər yeniləmədə və restartda yenidən giriş tələb edirdi | İnsanın şikayəti | Açarların faylda qalıcı saxlanması, token brauzerdə saxlanır, açıq səhifədə avtomatik yenilənir |
| Shell heredoc README cümləsini pozdu; bir yerdə tərcümə açarları əskik idi | Testlər və yoxlama | Əl ilə düzəliş, tərcümə açarlarının eyniliyini yoxlayan test |


## 6. Nəzarət və təhlükəsizlik qaydaları

- **Test:** AI-nin yazdığı kod testlər işlədilmədən qəbul edilmir. Hazırda **207 avtomatik test** keçir (başlanğıcda 32 idi). Tapılan hər səhv üçün test əlavə olunur.
- **Real yoxlama:** əsas axınlar başsız Chrome ilə iki tabda (vətəndaş və dispetçer) sınaqdan keçirildi: SOS göndərmə, briqada təyini, canlı yenilənmə, kəsilmə və bərpa, giriş və çıxış, flood paneli.
- **Məxfilik:** GitHub tokeni və digər gizli məlumatlar repozitoriyaya yazılmayıb; push zamanı müvəqqəti başlıq vasitəsilə istifadə olunub. Parollar demo dəyərlərdir və .env ilə dəyişdirilir.
- **Commit nəzarəti:** AI öz təşəbbüsü ilə commit etmir; yalnız insan "push et" dedikdə.
- **Tərcümə:** AZ/EN/RU lüğəti AI tərəfindən hazırlanıb, testlər açarların eyniliyini yoxlayır. Azərbaycan və rus mətnlərinin dil düzgünlüyünü komanda öz gözü ilə yoxlamalıdır; bir sıra ifadələr (məsələn, "Xarici API") insanın rəyi ilə dəyişdirildi.

## 7. Qərarlar kimə məxsusdur


| Qərarı verən | Nümunələr |
|---|---|
| İnsan (komanda) | Mobil PWA olsun; dizayn istiqaməti; "Təhlükəsizəm" düyməsinin yeri; mətnlərin peşəkarlığı; sağ və sol panellərin tablı düzəni; "SOS yoxdursa nə desin"; hansı yoldaş repozitoriyası ideyalarının götürülməsi; hər push |
| AI (insan təsdiqi ilə) | Alqoritmlərin və məlumat strukturlarının seçimi; test dəstinin tərkibi; kod quruluşu; Ed25519 imza açarı; yük testi metodu |


## 8. Məhdudiyyətlər

- Xarici marşrut xidməti real deyil, simulyasiya edilib (yuxarıda göstərilib).
- Vəziyyət yaddaşdadır (restartda sıfırlanır), bir instans üçün nəzərdə tutulub; çox instansda paylaşılan limit və verilənlər bazası lazım olacaq.
- Gecikmə ölçmələri tək kompüterdə (yerli) aparılıb; real şəbəkədə nəticələr fərqli ola bilər.

## 9. Təsdiq

Bu bəyannamə layihə üzərində real iş axınına əsaslanır: hansı alətin, nə vaxt və necə istifadə edildiyi yuxarıda göstərilib. Layihənin bütün məzmununa görə məsuliyyəti komanda daşıyır. AI aləti yalnız komandanın göstərişi ilə və komandanın yoxlaması altında işləyib.

Komanda nümayəndəsi: ______________________        Tarix: 15.11.2026

