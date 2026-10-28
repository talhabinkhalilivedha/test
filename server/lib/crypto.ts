import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_SECRET } from '../config.js';

/** AES-256-GCM with the app secret, for site passwords saved with a project. */
export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', APP_SECRET, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
}

export function decrypt(text: string): string {
  const [, iv, tag, data] = text.split(':');
  const decipher = createDecipheriv('aes-256-gcm', APP_SECRET, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
}
