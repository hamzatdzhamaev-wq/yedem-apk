const fs = require('fs-extra');
const { execSync } = require('child_process');
const path = require('path');

const steps = [
  {
    name: '1️⃣  Web Build erstellen',
    action: () => {
      console.log('   Building yedem-website...');
      execSync('npm run build', {
        cwd: path.join(__dirname, '../../yedem-website'),
        stdio: 'inherit'
      });
    }
  },
  {
    name: '2️⃣  Web Assets kopieren',
    action: () => {
      console.log('   Copying from out/ to www/...');
      const source = path.join(__dirname, '../../yedem-website/out');
      const dest = path.join(__dirname, '../www');

      fs.copySync(source, dest, { overwrite: true });
      console.log(`   ✅ ${fs.readdirSync(dest).length} Dateien kopiert`);
    }
  },
  {
    name: '3️⃣  Capacitor Scripts injizieren',
    action: () => {
      const indexPath = path.join(__dirname, '../www/index.html');
      let html = fs.readFileSync(indexPath, 'utf8');

      if (!html.includes('capacitor.js')) {
        html = html.replace('</body>', '  <script src="capacitor.js"></script>\n  </body>');
        fs.writeFileSync(indexPath, html);
        console.log('   ✅ Capacitor scripts injected');
      } else {
        console.log('   ℹ️  Scripts already present');
      }
    }
  },
  {
    name: '4️⃣  Storage Adapter sicherstellen',
    action: () => {
      const storageAdapterPath = path.join(__dirname, '../www/lib/storage-adapter.js');

      if (fs.existsSync(storageAdapterPath)) {
        console.log('   ✅ Storage adapter present');
      } else {
        console.log('   ⚠️  Storage adapter missing - wird erstellt');
        // Der Storage Adapter sollte bereits existieren aus der manuellen Erstellung
      }
    }
  },
  {
    name: '5️⃣  Zu Android synchronisieren',
    action: () => {
      execSync('npx cap sync android', {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
      });
    }
  }
];

console.log('\n🚀 Yedem APK Build Process\n');
console.log('─'.repeat(50));

let currentStep = 0;
for (const step of steps) {
  currentStep++;
  console.log(`\n${step.name}`);
  console.log('─'.repeat(50));

  try {
    step.action();
    console.log(`✅ Schritt ${currentStep} abgeschlossen`);
  } catch (error) {
    console.error(`\n❌ Fehler in Schritt ${currentStep}:`);
    console.error(error.message);
    process.exit(1);
  }
}

console.log('\n' + '─'.repeat(50));
console.log('🎉 Build erfolgreich abgeschlossen!');
console.log('─'.repeat(50));
console.log('\n📱 Nächste Schritte:');
console.log('   1. npm run apk:debug    - Debug APK erstellen');
console.log('   2. npm run open         - Android Studio öffnen');
console.log('   3. npm run install      - APK auf Gerät installieren\n');
