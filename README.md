# DualSubs — YouTube için çift altyazı (Safari)

YouTube videolarında iki altyazıyı aynı anda gösterir: üstte videonun kendi dili
(ör. İngilizce), altta seçtiğin dil (ör. Almanca). Videoda o dil yoksa YouTube'un
kendi otomatik çevirisi kullanılır.

## Kurulum (Xcode gerekmez)

1. Safari > Ayarlar > Gelişmiş > **"Web geliştiricileri için özellikleri göster"** kutusunu işaretle.
2. Safari > Ayarlar > **Geliştirici** sekmesi > **"Geçici Uzantı Ekle…"** (Add Temporary Extension…).
3. `extension` klasörünü seç. Uzantılar sekmesinde DualSubs'ı aç ve youtube.com için izin ver.

Not: Geçici uzantı Safari kapanınca kaldırılır; yeniden açınca 2–3. adımı tekrarla.
Kalıcı kurulum için Xcode ile `xcrun safari-web-extension-converter extension/`
komutuyla bir uygulama projesi oluşturup çalıştırman gerekir.

## Kullanım

- Araç çubuğundaki DualSubs simgesinden: aç/kapat, üst ve alt dil, yazı boyutu,
  arka plan saydamlığı, alt satır rengi.
- Eklenti açıkken YouTube'un kendi altyazısı gizlenir; kapatınca geri gelir.

## Nasıl çalışıyor

YouTube artık altyazı dosyalarını yalnızca oynatıcının ürettiği bir jetonla (`pot`)
veriyor. `inject.js` oynatıcının kendi altyazı isteğini yakalar, `content.js` aynı
jetonla iki dili `json3` olarak indirir ve videonun zamanına göre ekrana çizer.

| Dosya | Görevi |
|---|---|
| `manifest.json` | Uzantı tanımı (Manifest V3) |
| `inject.js` | Sayfa içinde çalışır: altyazı isteğini yakalar, parça listesini verir, indirir |
| `content.js` | Dilleri seçer, altyazıları ayrıştırır, katmanı çizer |
| `overlay.css` | Altyazı katmanının görünümü |
| `popup.*` | Ayarlar menüsü |
