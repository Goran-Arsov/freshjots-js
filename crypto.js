// Client-side encryption for Fresh Jots notes — format "fj1".
//
// You encrypt locally with your own passphrase; the server only ever stores
// the ciphertext this produces and can never read it. The wire format is:
//
//   "fj1:" + base64( salt[16] | iv[16] | ciphertext | mac[32] )
//
// A single PBKDF2-HMAC-SHA256 pass (210000 iterations) derives 64 bytes from
// your passphrase and the salt: the first 32 are the AES-256-CBC key, the last
// 32 are the HMAC-SHA256 key. The note is encrypted with AES-256-CBC and then
// authenticated encrypt-then-MAC: mac = HMAC-SHA256(mac_key, iv | ciphertext).
// Decryption verifies the MAC (constant time) before decrypting, so a wrong
// passphrase or any tampering is rejected.
//
// CBC+HMAC (not GCM) is deliberate: it is the one authenticated construction
// every Fresh Jots client can implement identically — including the bash CLI,
// whose openssl refuses AEAD ciphers. A note encrypted by any client (JS,
// Python, Ruby, or the shell CLI) decrypts with all the others. The output is
// a single line (base64 has no newlines), so it survives the server's newline
// append separator: encrypt each append as its own line and they decrypt
// independently. Uses only Node's built-in crypto (no dependencies).

import { pbkdf2Sync, createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "fj1:";
const ITERATIONS = 210000;
const SALT_LEN = 16;
const IV_LEN = 16;
const MAC_LEN = 32;

function deriveKeys(passphrase, salt) {
  const dk = pbkdf2Sync(Buffer.from(String(passphrase), "utf8"), salt, ITERATIONS, 64, "sha256");
  return { encKey: dk.subarray(0, 32), macKey: dk.subarray(32, 64) };
}

// True if `text` looks like a Fresh Jots ciphertext (carries the fj1: prefix).
// A declaration of shape, not a guarantee it decrypts — only decrypt() proves that.
export function isEncrypted(text) {
  return typeof text === "string" && text.startsWith(PREFIX);
}

// Encrypt a UTF-8 string with a passphrase; returns an "fj1:"-prefixed token.
export function encrypt(plaintext, passphrase) {
  if (!passphrase) throw new Error("encrypt requires a passphrase");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const { encKey, macKey } = deriveKeys(passphrase, salt);
  const cipher = createCipheriv("aes-256-cbc", encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), "utf8")), cipher.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest();
  return PREFIX + Buffer.concat([salt, iv, ciphertext, mac]).toString("base64");
}

// Decrypt an "fj1:" token back to its UTF-8 plaintext. Throws if the token is
// malformed, or if the passphrase is wrong / the ciphertext was tampered with
// (the MAC fails to verify).
export function decrypt(token, passphrase) {
  if (!passphrase) throw new Error("decrypt requires a passphrase");
  if (!isEncrypted(token)) {
    throw new Error("not a Fresh Jots ciphertext (missing 'fj1:' prefix)");
  }
  const blob = Buffer.from(token.slice(PREFIX.length), "base64");
  if (blob.length < SALT_LEN + IV_LEN + MAC_LEN + 16) {
    throw new Error("ciphertext is truncated or corrupted");
  }
  const salt = blob.subarray(0, SALT_LEN);
  const iv = blob.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const mac = blob.subarray(blob.length - MAC_LEN);
  const ciphertext = blob.subarray(SALT_LEN + IV_LEN, blob.length - MAC_LEN);
  const { encKey, macKey } = deriveKeys(passphrase, salt);
  const expected = createHmac("sha256", macKey).update(iv).update(ciphertext).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error("decryption failed — wrong passphrase or corrupted ciphertext");
  }
  const decipher = createDecipheriv("aes-256-cbc", encKey, iv);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("decryption failed — wrong passphrase or corrupted ciphertext");
  }
}
