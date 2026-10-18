/** Windows 局域网 HTTPS 证书：本机生成 CA 与服务器证书，所有私钥只落在 data/lan-tls。 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 45_000, ...options }, (error, stdout, stderr) => {
    if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
    resolve(String(stdout || '').trim());
  });
});

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');

export async function ensureWindowsLanCertificate({ dataDir, addresses = [], logger = console } = {}) {
  if (process.platform !== 'win32') return { available: false, reason: '首版 HTTPS 证书自动配置仅支持 Windows 主机' };
  const dir = path.join(dataDir, 'lan-tls');
  const pfxPath = path.join(dir, 'server.pfx');
  const caPath = path.join(dir, 'ai-study-local-ca.cer');
  const metaPath = path.join(dir, 'certificate.json');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const wanted = [...new Set(addresses.map(String).filter(Boolean))].sort();
  let old = null;
  try { old = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch { /* 首次生成 */ }
  if (old?.addresses?.join('|') === wanted.join('|') && old?.password) {
    try {
      const [pfx, ca] = await Promise.all([fs.readFile(pfxPath), fs.readFile(caPath)]);
      return { available: true, pfx, passphrase: old.password, caPath, addresses: wanted, generatedAt: old.generatedAt, expiresAt: old.expiresAt };
    } catch { /* 文件不完整则重签 */ }
  }

  const password = randomBytes(24).toString('base64url');
  const rootSubject = 'CN=AI Study Local CA';
  const host = os.hostname().replace(/[^\p{L}\p{N}._-]/gu, '-') || 'ai-study-host';
  const sanParts = ['DNS=localhost', `DNS=${host}`, ...wanted.map((ip) => `IPAddress=${ip}`)];
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force
Import-Module (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules/PKI/PKI.psd1') -Force
$dir = ${psQuote(dir)}
$caPath = ${psQuote(caPath)}
$pfxPath = ${psQuote(pfxPath)}
$password = [System.Security.SecureString]::new()
${psQuote(password)}.ToCharArray() | ForEach-Object { $password.AppendChar($_) }
$password.MakeReadOnly()
$root = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Subject -eq ${psQuote(rootSubject)} -and $_.NotAfter -gt (Get-Date).AddDays(60) } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $root) {
  $root = New-SelfSignedCertificate -Type Custom -Subject ${psQuote(rootSubject)} -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(8) -KeyUsage CertSign,CRLSign,DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=true&pathlength=1')
}
Export-Certificate -Cert $root -FilePath $caPath -Force | Out-Null
$leaf = New-SelfSignedCertificate -Type Custom -Subject ${psQuote(`CN=${host}`)} -Signer $root -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(2) -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @(${psQuote(`2.5.29.17={text}${sanParts.join('&')}`)},'2.5.29.19={critical}{text}ca=false','2.5.29.37={text}1.3.6.1.5.5.7.3.1')
Export-PfxCertificate -Cert $leaf -FilePath $pfxPath -Password $password -Force | Out-Null
[PSCustomObject]@{ expiresAt = $leaf.NotAfter.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
`;
  const output = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)]);
  const lastLine = output.split(/\r?\n/).filter(Boolean).at(-1);
  const result = JSON.parse(lastLine);
  const meta = { addresses: wanted, password, generatedAt: new Date().toISOString(), expiresAt: result.expiresAt };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  const [pfx, ca] = await Promise.all([fs.readFile(pfxPath), fs.readFile(caPath)]);
  logger?.log?.(`[transfer] 已为局域网地址 ${wanted.join(', ') || 'localhost'} 生成本机 HTTPS 证书`);
  return { available: true, pfx, passphrase: password, caPath, addresses: wanted, generatedAt: meta.generatedAt, expiresAt: meta.expiresAt, caBytes: ca.length };
}
