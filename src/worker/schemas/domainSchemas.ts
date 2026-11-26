import { z } from 'zod';

export const PaymentMethodSchema = z.object({
  code: z.string().min(2).max(32).regex(/^[A-Z0-9_]+$/),
  nameMy: z.string().min(1).max(64),
  nameEn: z.string().min(1).max(64),
  enabled: z.boolean(),
  instructionsMy: z.string().min(1).max(500),
  instructionsEn: z.string().min(1).max(500),
});

export const MenuButtonSchema = z.object({
  code: z.string().min(2).max(32),
  labelMy: z.string().min(1).max(64),
  labelEn: z.string().min(1).max(64),
});

export const AntiSecretPinOtpPattern =
  /\b(password|passwd|pin\s*[:=-]?\s*\d{4,6}|otp\s*[:=-]?\s*\d{4,8}|လျှို့ဝှက်နံပါတ်|ပင်နံပါတ်)\b/i;

export function containsForbiddenCustomerSecret(input: string): boolean {
  return AntiSecretPinOtpPattern.test(input);
}

export const AmountInputSchema = z.string().transform((val, ctx) => {
  const cleaned = val.replace(/[,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'INVALID_INTEGER_AMOUNT',
    });
    return z.NEVER;
  }
  const num = Number(cleaned);
  if (!Number.isSafeInteger(num) || num <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'AMOUNT_MUST_BE_POSITIVE',
    });
    return z.NEVER;
  }
  return num;
});
