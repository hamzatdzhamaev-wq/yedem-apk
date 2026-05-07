# Yedem Android APK

Android-Version der Yedem Food Delivery Plattform, erstellt mit Capacitor.

## 📱 Über das Projekt

Diese APK verwendet die gleiche Codebasis wie die Yedem-Website und verbindet sich mit dem selben Backend (`https://api.eda-yedem.ru`).

**Features:**
- ✅ Alle Funktionen der Web-Version
- ✅ Native Mobile Features (Kamera, Geolocation, Push Notifications)
- ✅ Offline-fähig mit Service Worker
- ✅ Sichere Datenspeicherung mit Capacitor Preferences
- ✅ Optimiert für Android 8.0+

## 🚀 Quick Start

### Voraussetzungen

- Node.js (bereits installiert)
- Android Studio (für APK-Erstellung)
- JDK 11+ (für Gradle)

### Build-Prozess

```bash
# 1. Kompletten Build ausführen
npm run build

# 2. Android Studio öffnen
npm run open

# 3. Im Android Studio: Build → Build Bundle(s) / APK(s) → Build APK(s)
```

### Alternative: Command Line Build

```bash
# Debug APK erstellen
npm run apk:debug

# Release APK erstellen (für Veröffentlichung)
npm run apk:release
```

## 📦 Verfügbare Scripts

| Script | Beschreibung |
|--------|-------------|
| `npm run build` | Komplett-Build (Web + Android Sync) |
| `npm run build:web` | Nur Web-Version bauen |
| `npm run copy` | Web Assets nach www/ kopieren |
| `npm run sync` | Mit Android synchronisieren |
| `npm run open` | Android Studio öffnen |
| `npm run apk:debug` | Debug APK erstellen |
| `npm run apk:release` | Release APK erstellen |
| `npm run install` | APK auf Gerät installieren (via ADB) |
| `npm run run` | Build + Install in einem |

## 📁 Projektstruktur

```
Yedem-APK/
├── android/                 # Capacitor Android-Projekt
│   ├── app/
│   │   ├── src/main/
│   │   │   ├── AndroidManifest.xml
│   │   │   ├── res/         # Icons & Resources
│   │   │   └── assets/      # Web Build
│   │   └── build.gradle
│   └── build.gradle
├── www/                     # Gebaute Web-Assets
│   ├── lib/
│   │   └── storage-adapter.js  # localStorage → Capacitor Preferences
│   └── index.html
├── scripts/
│   ├── build-all.js         # Haupt-Build-Script
│   ├── copy-web-assets.js   # Asset-Kopierer
│   └── inject-capacitor.js  # Capacitor-Injection
├── capacitor.config.ts      # Capacitor-Konfiguration
└── package.json
```

## 🔧 Konfiguration

### capacitor.config.ts

```typescript
{
  appId: 'ru.eda_yedem.app',
  appName: 'Yedem',
  server: {
    androidScheme: 'https',
    hostname: 'eda-yedem.ru'  // Wichtig für CORS
  }
}
```

### Backend

Das Backend läuft auf `https://api.eda-yedem.ru` und benötigt keine Änderungen.

## 🎨 Icons & Assets

Die App-Icons werden automatisch aus der Web-Version übernommen:
- `yedem-website/public/icon-512x512.png` → App Icon
- `yedem-website/public/splash-logo.png` → Splash Screen

## 🔒 Permissions

Die App benötigt folgende Berechtigungen:

- **Internet** - API-Zugriff
- **Location** - Lieferadresse & Distanzberechnung
- **Camera** - Produkt-Bilder hochladen
- **Storage** - Foto-Speicherung
- **Notifications** - Order Status Updates

Alle Permissions sind in `android/app/src/main/AndroidManifest.xml` definiert.

## 📲 Installation auf Gerät

### Via USB (ADB)

```bash
# 1. USB Debugging aktivieren (Einstellungen → Entwickleroptionen)
# 2. Gerät via USB verbinden
# 3. APK installieren
npm run install
```

### Via APK-Datei

Die APK befindet sich nach dem Build hier:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

Diese Datei kann:
- Per USB auf Gerät kopiert und installiert werden
- Per Email/Cloud verschickt werden
- Auf Website zum Download angeboten werden

## 🧪 Testing

### Funktionen testen

- [ ] Login / Registration
- [ ] Shop browsing
- [ ] Product auswählen & in Warenkorb
- [ ] Checkout mit Adresse
- [ ] Order tracking
- [ ] Seller Dashboard
- [ ] Deliverer Dashboard
- [ ] Chat-Funktion
- [ ] Dark Mode
- [ ] Offline-Verhalten

### Performance

- [ ] App startet in < 3 Sekunden
- [ ] Bilder laden schnell
- [ ] Scrolling flüssig
- [ ] Keine Crashes

## 🚢 Release-Prozess

### 1. Signing Key erstellen (einmalig)

```bash
keytool -genkey -v -keystore yedem-release.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias yedem
```

### 2. Signing Config in build.gradle

Siehe detaillierte Anleitung im Plan: `C:\Users\PC\.claude\plans\dreamy-juggling-hippo.md`

### 3. Release APK erstellen

```bash
npm run apk:release
```

### 4. Google Play Store

Siehe vollständige Anleitung im Planfile → Abschnitt "Google Play Store Deployment"

## 🔄 Updates veröffentlichen

```bash
# 1. Version in build.gradle erhöhen
# android/app/build.gradle:
#   versionCode 2
#   versionName "1.0.1"

# 2. Web-Version aktualisieren
cd ../yedem-website
# ... Änderungen machen ...
npm run build

# 3. APK neu bauen
cd ../Yedem-APK
npm run build
npm run apk:release
```

## 🐛 Troubleshooting

### CORS-Fehler in APK

**Problem:** API-Requests werden blockiert

**Lösung:** `capacitor.config.ts` prüfen:
```typescript
server: {
  hostname: 'eda-yedem.ru'  // Muss gesetzt sein!
}
```

### localStorage funktioniert nicht

**Problem:** User wird nach App-Neustart ausgeloggt

**Lösung:** Storage Adapter prüfen in `www/lib/storage-adapter.js`

### Gradle Build Error

**Lösung:**
```bash
cd android
./gradlew clean
./gradlew build --refresh-dependencies
```

### APK zu groß

**Lösung:** App Bundle (AAB) verwenden statt APK:
```bash
cd android
./gradlew bundleRelease
```

## 📚 Weitere Ressourcen

- **Detaillierter Plan:** `C:\Users\PC\.claude\plans\dreamy-juggling-hippo.md`
- **Capacitor Docs:** https://capacitorjs.com/docs
- **Android Docs:** https://developer.android.com

## 📞 Support

Bei Problemen:
1. Plan-Datei konsultieren (enthält alle Lösungen)
2. Logs prüfen: `adb logcat`
3. Chrome DevTools: `chrome://inspect`

---

**Version:** 1.0.0
**Backend:** https://api.eda-yedem.ru
**Web Version:** https://eda-yedem.ru
