# CaptionDuet — YouTube için çift altyazı (Safari)

YouTube videolarında iki altyazıyı aynı anda gösterir: üstte videonun kendi dili
(ör. İngilizce), altta seçtiğin dil (ör. Almanca). Videoda o dil yoksa YouTube'un
kendi otomatik çevirisi kullanılır.

## Kurulum (Xcode gerekmez)

1. Safari > Ayarlar > Gelişmiş > **"Web geliştiricileri için özellikleri göster"** kutusunu işaretle.
2. Safari > Ayarlar > **Geliştirici** sekmesi > **"Geçici Uzantı Ekle…"** (Add Temporary Extension…).
3. `extension` klasörünü seç. Uzantılar sekmesinde CaptionDuet'ı aç ve youtube.com için izin ver.

Not: Geçici uzantı Safari kapanınca kaldırılır; yeniden açınca 2–3. adımı tekrarla.

### Kalıcı kurulum (Xcode gerekir)

1. App Store'dan Xcode'u kur ve bir kez aç.
2. `sudo xcode-select -s /Applications/Xcode.app` ile etkin geliştirici dizinini Xcode yap.
3. `xcrun safari-web-extension-converter extension/ --project-location xcode --macos-only`
4. Açılan projeyi Xcode'da çalıştır (⌘R), sonra Safari > Ayarlar > Uzantılar'dan CaptionDuet'ı aç.
   İmzasız yapı için Safari > Geliştirici > "İmzasız Uzantılara İzin Ver" gerekir.

## Kullanım

- Araç çubuğundaki CaptionDuet simgesinden: aç/kapat, üst ve alt dil, yazı boyutu,
  arka plan saydamlığı, alt satır rengi.
- Dil menüsünde önce açık videonun kendi altyazıları, sonra YouTube'un otomatik
  çevirebildiği diller listelenir. Durum satırı o sekmedeki videoya aittir.
- Normal videolarda, Shorts'ta ve canlı yayın sayfalarında çalışır.
- Otomatik altyazılarda satır yerinde durur, kelimeler söylendikçe belirir.
- Eklenti açıkken YouTube'un kendi altyazısı gizlenir. Altyazın kapalıysa eklenti onu
  yalnızca jetonu almak için bir anlığına açar ve yeniden kapatır.

### Bilinen sınırlar

- Başka sitelere gömülü oynatıcılar (`/embed/`) desteklenmez.
- Otomatik altyazısı olmayan videolarda YouTube konuşulan dili bildirmez; "Videonun kendi
  dili" listedeki ilk altyazıyı seçer ve bu yanlış dil olabilir. Menüden dili elle seç.

## Nasıl çalışıyor

YouTube artık altyazı dosyalarını yalnızca oynatıcının ürettiği bir jetonla (`pot`)
veriyor. `inject.js` oynatıcının kendi altyazı isteğini yakalar, `content.js` aynı
jetonla iki dili `json3` olarak indirir ve videonun zamanına göre ekrana çizer.

| Dosya | Görevi |
|---|---|
| `manifest.json` | Uzantı tanımı (Manifest V3) |
| `inject.js` | Sayfa içinde çalışır: altyazı isteğini yakalar, parça listesini verir, indirir |
| `core.js` | Saf mantık: dil seçimi, adres üretimi, `json3` ayrıştırma, etkin satır |
| `content.js` | Akışı yönetir ve katmanı çizer |
| `overlay.css` | Altyazı katmanının görünümü |
| `popup.*` | Ayarlar menüsü |

`inject.js` manifest'teki `"world": "MAIN"` ile doğrudan sayfaya yüklenir (Safari'de
doğrulandı). Sayfa betiği cevap vermezse yedek moda geçilir. Hangi yolun kullanıldığı
popup'taki durum satırında yazar: `tam mod` veya `yedek mod`.

## Testler

Testler gerçek bir `URL` uygulaması istediği için tarayıcıda çalışır:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

- <http://127.0.0.1:8765/tests/> — `core.js` birim testleri.
- <http://127.0.0.1:8765/tests/smoke.html> — gerçek `inject.js` + `content.js`, sahte bir
  oynatıcıya karşı uçtan uca bağlantı testi. Sekme önde olmalı; arka plandaki sekmede
  tarayıcı kare çizmediği için test beklemede kalır.
- <http://127.0.0.1:8765/tests/popup.html> — gerçek popup, sahte bir sekmeye karşı.

Sekme başlığı `PASS` ya da `FAIL` olur. Örnek altyazı dosyaları YouTube'un `json3`
biçiminde elle yazılmıştır, kayıtlı gerçek yanıtlar değildir; testler YouTube'un
davranışının değişip değişmediğini söyleyemez.

## Yasal not

CaptionDuet bağımsız bir projedir; YouTube veya Google ile bir bağlantısı, ortaklığı ya da
onayı yoktur. YouTube, Google LLC'nin ticari markasıdır ve burada yalnızca eklentinin hangi
sitede çalıştığını belirtmek için anılır.
