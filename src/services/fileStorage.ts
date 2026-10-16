import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// Claim documents (x-rays, photos, denial notices) are stored as encrypted files on the server's
// disk instead of inside the database. The folder is outside the app directory, so deploys don't
// touch it, and nothing in it is served directly: files are only read through the signed-in API.
//
// FILE_STORAGE_DIR    where files go (default: ~/dentalappeal-files)
// FILE_ENCRYPTION_KEY 64 hex characters. If unset, a key is derived from JWT_SECRET; in that case
//                     changing JWT_SECRET makes existing files unreadable.

export const STORAGE_DIR = process.env.FILE_STORAGE_DIR || path.join(os.homedir(), 'dentalappeal-files');

function encryptionKey(): Buffer {
  const configured = process.env.FILE_ENCRYPTION_KEY;
  if (configured && /^[0-9a-fA-F]{64}$/.test(configured)) return Buffer.from(configured, 'hex');
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('No FILE_ENCRYPTION_KEY or JWT_SECRET to encrypt files with');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'dentalappeal-files', 'document-encryption-v1', 32));
}

// Keys look like "2026/10/<uuid>.bin"; anything else is rejected so a key can't point outside the folder.
const KEY_PATTERN = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.bin$/;
const fullPath = (key: string) => {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  return path.join(STORAGE_DIR, key);
};

// File layout: 12-byte IV | 16-byte auth tag | AES-256-GCM ciphertext.
export async function saveFile(data: Buffer): Promise<string> {
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.bin`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const target = fullPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
  return key;
}

export async function readFile(key: string): Promise<Buffer> {
  const stored = await fs.readFile(fullPath(key));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), stored.subarray(0, 12));
  decipher.setAuthTag(stored.subarray(12, 28));
  return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]);
}

export async function deleteFile(key: string): Promise<void> {
  await fs.rm(fullPath(key), { force: true });
}

// Write, read back and delete a small file: proves the folder is usable and the key works.
export async function checkStorage(): Promise<boolean> {
  try {
    const probe = Buffer.from(`check ${Date.now()}`);
    const key = await saveFile(probe);
    const ok = (await readFile(key)).equals(probe);
    await deleteFile(key);
    return ok;
  } catch (error) {
    console.error('File storage check failed:', error);
    return false;
  }
}
