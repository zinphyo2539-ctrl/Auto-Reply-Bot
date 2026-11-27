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
  const trimmedProvided = providedSecret.trim();
  const trimmedExpected = expectedSecret.trim();
  if (
    !trimmedProvided ||
    !trimmedExpected ||
    PLACEHOLDER_KEY_PATTERNS.some((re) => re.test(trimmedExpected))
  ) {
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

export const CURRENT_AUDIT_HASH_VERSION = 2;
export const CURRENT_CHECKPOINT_HASH_VERSION = 2;

export type CanonicalFieldType = 'N' | 'S' | 'I' | 'J' | 'R';

export interface CanonicalField {
  name: string;
  type: CanonicalFieldType;
  value: string;
}

/**
 * Recursively canonicalizes JSON values by sorting plain-object keys lexicographically
 * while preserving array element order and matching JSON.stringify undefined-omission semantics.
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalizeJsonValue(item)));
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const val = record[key];
    if (val !== undefined) {
      sorted[key] = canonicalizeJsonValue(val);
    }
  }
  return sorted;
}

/**
 * Serializes an optional structured object into deterministic canonical JSON text (or null).
 */
export function serializeCanonicalJson(value: Record<string, unknown> | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(canonicalizeJsonValue(value));
}

/**
 * Normalizes a persisted nullable JSON text column into a strictly typed canonical field:
 * - null / undefined -> tag 'N' (empty)
 * - valid JSON text  -> tag 'J' with recursively sorted keys (key-order invariant)
 * - invalid raw text -> tag 'R' preserving exact raw bytes (distinct from null and valid JSON)
 */
export function canonicalizeNullableJsonField(
  name: string,
  raw: string | null | undefined
): CanonicalField {
  if (raw === null || raw === undefined) {
    return { name, type: 'N', value: '' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return {
      name,
      type: 'J',
      value: JSON.stringify(canonicalizeJsonValue(parsed)),
    };
  } catch {
    return {
      name,
      type: 'R',
      value: raw,
    };
  }
}

function makeRequiredStringField(name: string, value: string): CanonicalField {
  return { name, type: 'S', value };
}

function makeNullableStringField(name: string, value: string | null | undefined): CanonicalField {
  if (value === null || value === undefined) {
    return { name, type: 'N', value: '' };
  }
  return { name, type: 'S', value };
}

function makeRequiredIntField(name: string, value: number): CanonicalField {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`CANONICAL_INVALID_INTEGER_${name.toUpperCase()}`);
  }
  return { name, type: 'I', value: String(value) };
}

function makeNullableIntField(name: string, value: number | null | undefined): CanonicalField {
  if (value === null || value === undefined) {
    return { name, type: 'N', value: '' };
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`CANONICAL_INVALID_INTEGER_${name.toUpperCase()}`);
  }
  return { name, type: 'I', value: String(value) };
}

/**
 * Single shared unambiguous length-prefixed canonical encoder for audit entries and checkpoints.
 * Each field encodes: `<name>=<type>:<utf8ByteLength>:<exactUtf8Value>\n`
 * Because every value is prefixed with its exact UTF-8 byte length and explicit type tag,
 * delimiters (`|`, quotes, backslashes, newlines, NUL bytes, Unicode) can never collide across fields.
 */
export function encodeCanonicalRecord(fields: readonly CanonicalField[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    const byteLen = encoder.encode(field.value).byteLength;
    parts.push(`${field.name}=${field.type}:${byteLen}:${field.value}\n`);
  }
  return parts.join('');
}

export interface AuditEntryHashParams {
  prevHash: string;
  auditId: string;
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  beforeStateJson?: string | null;
  afterStateJson?: string | null;
  reason?: string | null;
  sourceUpdateId?: number | null;
  createdAt: number;
  correlationId: string;
  hashVersion?: number;
}

export async function computeAuditEntryHash(params: AuditEntryHashParams): Promise<string> {
  const version = params.hashVersion ?? CURRENT_AUDIT_HASH_VERSION;

  if (version === 1) {
    // Legacy v1 read-only verification format for historical rows created prior to migration 0005.
    const legacyCanonical = [
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
    return sha256Hex(legacyCanonical);
  }

  if (version === 2) {
    const canonical = encodeCanonicalRecord([
      makeRequiredStringField('domain', '7777club.audit_entry'),
      makeRequiredIntField('hash_version', 2),
      makeRequiredStringField('prev_entry_hash', params.prevHash),
      makeRequiredStringField('audit_id', params.auditId),
      makeRequiredStringField('actor_id', params.actorId),
      makeRequiredStringField('actor_role', params.actorRole),
      makeRequiredStringField('action', params.action),
      makeRequiredStringField('resource_type', params.resourceType),
      makeRequiredStringField('resource_id', params.resourceId),
      makeRequiredStringField('result', params.result),
      canonicalizeNullableJsonField('before_state_json', params.beforeStateJson),
      canonicalizeNullableJsonField('after_state_json', params.afterStateJson),
      makeNullableStringField('reason', params.reason),
      makeNullableIntField('source_update_id', params.sourceUpdateId),
      makeRequiredIntField('created_at', params.createdAt),
      makeRequiredStringField('correlation_id', params.correlationId),
    ]);
    return sha256Hex(canonical);
  }

  throw new Error(`UNSUPPORTED_AUDIT_HASH_VERSION:${String(version)}`);
}

export interface AuditCheckpointHashParams {
  prevCheckpointHash: string;
  checkpointId: string;
  anchorAuditId: string;
  anchorEntryHash: string;
  anchorCreatedAt: number;
  purgedCount: number;
  createdAt: number;
  hashVersion?: number;
}

export async function computeAuditCheckpointHash(params: AuditCheckpointHashParams): Promise<string> {
  const version = params.hashVersion ?? CURRENT_CHECKPOINT_HASH_VERSION;

  if (version === 1) {
    // Legacy v1 read-only verification format for historical checkpoints prior to migration 0005.
    const legacyCanonical = [
      params.prevCheckpointHash,
      params.checkpointId,
      params.anchorAuditId,
      params.anchorEntryHash,
      String(params.anchorCreatedAt),
      String(params.purgedCount),
      String(params.createdAt),
    ].join('|');
    return sha256Hex(legacyCanonical);
  }

  if (version === 2) {
    const canonical = encodeCanonicalRecord([
      makeRequiredStringField('domain', '7777club.audit_checkpoint'),
      makeRequiredIntField('hash_version', 2),
      makeRequiredStringField('prev_checkpoint_hash', params.prevCheckpointHash),
      makeRequiredStringField('checkpoint_id', params.checkpointId),
      makeRequiredStringField('anchor_audit_id', params.anchorAuditId),
      makeRequiredStringField('anchor_entry_hash', params.anchorEntryHash),
      makeRequiredIntField('anchor_created_at', params.anchorCreatedAt),
      makeRequiredIntField('purged_count', params.purgedCount),
      makeRequiredIntField('created_at', params.createdAt),
    ]);
    return sha256Hex(canonical);
  }

  throw new Error(`UNSUPPORTED_CHECKPOINT_HASH_VERSION:${String(version)}`);
}
