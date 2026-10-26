// OAuth records exceed Credential Manager's per-entry limit. Keep one encryption key in the
// existing OS store and an authenticated, atomically replaced ciphertext beside the app's config.
// A session-only keystore must never produce a persistent token file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createOAuthStore({ keystore, file }) {
  let memory = null;
  let key = null;
  async function secret(create) {
    if (key) return key;
    let saved = await keystore.get('chatgpt-vault');
    if (!saved && create) {
      saved = crypto.randomBytes(32).toString('base64url');
      await keystore.set('chatgpt-vault', saved);
    }
    if (!saved) throw new Error('ChatGPT credentials are unavailable. Sign in again.');
    key = Buffer.from(saved, 'base64url');
    if (key.length !== 32) throw new Error('ChatGPT credentials are unavailable. Sign in again.');
    return key;
  }
  return {
    async load() {
      if (!keystore.persistent) return memory;
      let bytes;
      try { bytes = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      const decipher = crypto.createDecipheriv('aes-256-gcm', await secret(false), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    },
    async save(value) {
      if (!keystore.persistent) { memory = structuredClone(value); return; }
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', await secret(true), iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally { fs.rmSync(tmp, { force: true }); }
    },
  };
}
