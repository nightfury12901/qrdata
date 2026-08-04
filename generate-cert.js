/**
 * generate-cert.js — One-time self-signed certificate generator.
 *
 * Tries system `openssl`, then Git-for-Windows bundled openssl.
 * Generates cert/key.pem and cert/cert.pem for the local HTTPS dev server.
 * The cert is self-signed and covers any hostname — the phone browser will
 * show a warning you can bypass once.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certDir = path.join(__dirname, 'cert');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);

const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  console.log('Certificates already exist in cert/. Delete them to regenerate.');
  process.exit(0);
}

// openssl command — creates a self-signed cert valid for 365 days
const cmd = (bin) =>
  `"${bin}" req -x509 -newkey rsa:2048 ` +
  `-keyout "${keyPath}" -out "${certPath}" ` +
  `-days 365 -nodes -subj "/CN=PhotonDev"`;

const candidates = [
  'openssl',                                           // system PATH
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',     // Git for Windows
  'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
];

let success = false;
for (const bin of candidates) {
  try {
    execSync(cmd(bin), { stdio: 'pipe' });
    console.log(`✓ Certificate generated using: ${bin}`);
    console.log(`  Key:  ${keyPath}`);
    console.log(`  Cert: ${certPath}`);
    success = true;
    break;
  } catch {
    // try next candidate
  }
}

if (!success) {
  console.error(
    '✗ Could not find openssl. Install one of:\n' +
    '  • Git for Windows (includes openssl)\n' +
    '  • OpenSSL via chocolatey: choco install openssl\n' +
    '  • Or manually place key.pem and cert.pem in the cert/ directory.\n\n' +
    'Alternative: skip HTTPS and use an ngrok/localtunnel tunnel:\n' +
    '  npx localtunnel --port 3000'
  );
  process.exit(1);
}
