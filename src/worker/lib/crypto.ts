import { timingSafeEqual } from 'node:crypto';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function constantTimeSecretMatch(
  providedSecret: string | null | undefined,
  expectedSecret: string | null | undefined
): Promise<boolean> {
  if (!providedSecret || !expectedSecret) {
    return false;
  }
  // Hash both values with SHA-256 so fixed 32-byte digests are compared in constant time
  // without leaking the secret's length.
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(providedSecret)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret)),
  ]);
  const bufA = new Uint8Array(digestA);
  const bufB = new Uint8Array(digestB);
  if (bufA.byteLength !== bufB.byteLength) {
    return false;
  }
  const lenMatch = providedSecret.length === expectedSecret.length;
  const hashMatch = timingSafeEqual(bufA, bufB);
  return lenMatch && hashMatch;
}

async function importAesGcmKey(rawSecret: string): Promise<CryptoKey> {
  // Derive a deterministic 256-bit AES key from the secret material via SHA-256
  const keyDigest = await crypto.subtle.digest('SHA-256', encoder.encode(rawSecret));
  return crypto.subtle.importKey('raw', keyDigest, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface EncryptedDestinationPayload {
  ciphertext: string;
  iv: string;
  masked: string;
  keyVersion: number;
}

export interface DestinationAadContext {
  customerId: string;
  methodCode: string;
  keyVersion: number;
}

function buildAadBytes(ctx: DestinationAadContext): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(`v303:wd_pii:${ctx.customerId}:${ctx.methodCode}:kv${ctx.keyVersion}`);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

export function maskPayoutDestination(rawDestination: string): string {
  const digits = rawDestination.replace(/\D/g, '');
  if (digits.length >= 4) {
    return `***${digits.slice(-4)}`;
  }
  const trimmed = rawDestination.trim();
  if (trimmed.length >= 4) {
    return `***${trimmed.slice(-4)}`;
  }
  return '***REDACTED';
}

export async function encryptPayoutDestination(
  plaintextDestination: string,
  secretKey: string,
  aadContext: DestinationAadContext
): Promise<EncryptedDestinationPayload> {
  if (!secretKey || secretKey.trim().length < 16) {
    throw new Error('ENCRYPTION_KEY_MISSING_OR_WEAK');
  }
  const key = await importAesGcmKey(secretKey);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const aad = buildAadBytes(aadContext);

  const encryptedBuf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    encoder.encode(plaintextDestination)
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encryptedBuf)),
    iv: bytesToBase64(iv),
    masked: maskPayoutDestination(plaintextDestination),
    keyVersion: aadContext.keyVersion,
  };
}

export async function decryptPayoutDestination(
  ciphertextB64: string,
  ivB64: string,
  aadContext: DestinationAadContext,
  keys: { currentKey: string; previousKey?: string; currentKeyVersion: number }
): Promise<string> {
  if (ciphertextB64 === 'REDACTED' || ivB64 === 'REDACTED') {
    throw new Error('DESTINATION_PII_ALREADY_REDACTED');
  }

  const candidateSecret =
    aadContext.keyVersion === keys.currentKeyVersion
      ? keys.currentKey
      : keys.previousKey || keys.currentKey;

  if (!candidateSecret || candidateSecret.trim().length < 16) {
    throw new Error('DECRYPTION_KEY_UNAVAILABLE');
  }

  const key = await importAesGcmKey(candidateSecret);
  const iv = base64ToBytes(ivB64);
  const ciphertext = base64ToBytes(ciphertextB64);
  const aad = buildAadBytes(aadContext);

  const decryptedBuf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: aad,
      tagLength: 128,
    },
    key,
    ciphertext
  );

  return decoder.decode(decryptedBuf);
}

export async function computeAuditEntryHash(params: {
  prevHash: string;
  auditId: string;
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  createdAt: number;
  correlationId: string;
}): Promise<string> {
  const canonical = [
    params.prevHash,
    params.auditId,
    params.actorId,
    params.actorRole,
    params.action,
    params.resourceType,
    params.resourceId,
    params.result,
    String(params.createdAt),
    params.correlationId,
  ].join('|');
  return sha256Hex(canonical);
}
