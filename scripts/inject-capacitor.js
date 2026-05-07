const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '../www/index.html');

console.log('💉 Injiziere Capacitor Scripts...');

try {
  if (!fs.existsSync(indexPath)) {
    throw new Error(`index.html nicht gefunden: ${indexPath}`);
  }

  let html = fs.readFileSync(indexPath, 'utf8');

  // Prüfen ob bereits injiziert
  if (html.includes('capacitor.js')) {
    console.log('ℹ️  Capacitor Scripts bereits vorhanden');
    return;
  }

  // Capacitor Scripts vor </body> einfügen
  html = html.replace(
    '</body>',
    '  <script src="capacitor.js"></script>\n  </body>'
  );

  fs.writeFileSync(indexPath, html);
  console.log('✅ Capacitor Scripts erfolgreich injiziert!');
} catch (error) {
  console.error('❌ Fehler beim Injizieren:', error.message);
  process.exit(1);
}
