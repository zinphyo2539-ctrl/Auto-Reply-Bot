const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PLACEHOLDER_KEY_PATTERNS = [
  /^CONFIGURED_IN_CLOUDFLARE_ENV$/i,
  /^PENDING_OWNER_CONFIRMATION$/i,
  /^PENDING_OWNER_CONFIGURATION$/i,
  /^<.*>$/,
  /^CHANGE_ME/i,
  /^REPLACE_ME/i,
  /^YOUR_/i,
  /^EXAMPLE/i,
];

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

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Strictly parses a 32-byte (256-bit) AES encryption key encoded as either:
 * - 64-character hexadecimal, or
 * - Standard/URL-safe base64 decoding to exactly 32 bytes.
 * Never hashes arbitrary password strings into a key; fails closed on placeholders or weak keys.
 */
export function parseAes256KeyBytes(rawSecret: string | null | undefined): Uint8Array<ArrayBuffer> {
  if (!rawSecret || typeof rawSecret !== 'string') {
    throw new Error('ENCRYPTION_KEY_MISSING_OR_INVALID');
  }
  const trimmed = rawSecret.trim();
  if (!trimmed || PLACEHOLDER_KEY_PATTERNS.some((re) => re.test(trimmed))) {
    throw new Error('ENCRYPTION_KEY_PLACEHOLDER_REJECTED');
  }

  let keyBytes: Uint8Array<ArrayBuffer>;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    keyBytes = hexToBytes(trimmed);
  } else {
    // Normalize base64url to standard base64 and verify strict character set before decoding
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
      throw new Error('ENCRYPTION_KEY_INVALID_ENCODING');
    }
    const padded =
      normalized.length % 4 === 0
        ? normalized
        : normalized + '='.repeat(4 - (normalized.length % 4));
    try {
      keyBytes = base64ToBytes(padded);
    } catch {
      throw new Error('ENCRYPTION_KEY_INVALID_BASE64');
    }
    // Reject non-canonical base64 (e.g. stray trailing bits or unexpected text)
    if (keyBytes.byteLength !== 32 || bytesToBase64(keyBytes) !== padded) {
      throw new Error('ENCRYPTION_KEY_MUST_DECODE_TO_32_BYTES');
    }
  }

  if (keyBytes.byteLength !== 32) {
    throw new Error('ENCRYPTION_KEY_MUST_DECODE_TO_32_BYTES');
  }

  // Reject trivial all-zero or low-variety repeated byte keys
  const uniqueByteCount = new Set(keyBytes).size;
  if (uniqueByteCount < 4) {
    throw new Error('ENCRYPTION_KEY_INSUFFICIENT_ENTROPY');
  }

  return keyBytes;
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
  // without leaking the secret's length and without requiring node:crypto.
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(providedSecret)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret)),
  ]);
  const bufA = new Uint8Array(digestA);
  const bufB = new Uint8Array(digestB);
  if (bufA.byteLength !== bufB.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

async function importAesGcmKey(rawSecret: string): Promise<CryptoKey> {
  const keyBytes = parseAes256KeyBytes(rawSecret);
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, [
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
  purpose?: 'withdrawal_destination';
  customerId: string;
  recordToken: string;
  methodCode: string;
  keyVersion: number;
}

function encodeLengthPrefixedField(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`AAD_FIELD_REQUIRED_${label.toUpperCase()}`);
  }
  return `${label}=${trimmed.length}:${trimmed}`;
}

function buildAadBytes(ctx: DestinationAadContext): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(ctx.keyVersion) || ctx.keyVersion < 1) {
    throw new Error('AAD_INVALID_KEY_VERSION');
  }
  const purpose = ctx.purpose ?? 'withdrawal_destination';
  const canonical = [
    'v304',
    encodeLengthPrefixedField('purpose', purpose),
    encodeLengthPrefixedField('customer_id', ctx.customerId),
    encodeLengthPrefixedField('record_token', ctx.recordToken),
    encodeLengthPrefixedField('method_code', ctx.methodCode),
    `kv=${ctx.keyVersion}`,
  ].join('|');

  const encoded = encoder.encode(canonical);
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

  if (!Number.isInteger(keys.currentKeyVersion) || keys.currentKeyVersion < 1) {
    throw new Error('INVALID_CURRENT_ENCRYPTION_KEY_VERSION');
  }

  let candidateSecret: string;
  if (aadContext.keyVersion === keys.currentKeyVersion) {
    candidateSecret = keys.currentKey;
  } else if (aadContext.keyVersion === keys.currentKeyVersion - 1) {
    if (!keys.previousKey || !keys.previousKey.trim()) {
      throw new Error('DECRYPTION_KEY_UNAVAILABLE');
    }
    candidateSecret = keys.previousKey;
  } else {
    throw new Error('UNSUPPORTED_ENCRYPTION_KEY_VERSION');
  }

  const key = await importAesGcmKey(candidateSecret);
  const iv = base64ToBytes(ivB64);
  if (iv.byteLength !== 12) {
    throw new Error('INVALID_AES_GCM_IV_LENGTH');
  }
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

export async function computeAuditCheckpointHash(params: {
  prevCheckpointHash: string;
  checkpointId: string;
  anchorAuditId: string;
  anchorEntryHash: string;
  anchorCreatedAt: number;
  purgedCount: number;
  createdAt: number;
}): Promise<string> {
  const canonical = [
    params.prevCheckpointHash,
    params.checkpointId,
    params.anchorAuditId,
    params.anchorEntryHash,
    String(params.anchorCreatedAt),
    String(params.purgedCount),
    String(params.createdAt),
  ].join('|');
  return sha256Hex(canonical);
}
