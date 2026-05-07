const fs = require('fs-extra');
const path = require('path');

const source = path.join(__dirname, '../../yedem-website/out');
const dest = path.join(__dirname, '../www');

console.log('📦 Kopiere Web Assets...');
console.log(`   Von: ${source}`);
console.log(`   Nach: ${dest}`);

try {
  // Ensure destination exists
  fs.ensureDirSync(dest);

  // Copy files
  fs.copySync(source, dest, { overwrite: true });

  console.log('✅ Web Assets erfolgreich kopiert!');
  console.log(`   Dateien in www/: ${fs.readdirSync(dest).length}`);
} catch (error) {
  console.error('❌ Fehler beim Kopieren:', error.message);
  process.exit(1);
}
