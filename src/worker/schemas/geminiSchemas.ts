import { z } from 'zod';

export const GeminiSupportOutputSchema = z.object({
  replyText: z.string().min(1).max(3500),
  requiresHumanHandover: z.boolean(),
  ticketCategory: z.enum(['NONE', 'GENERAL_SUPPORT', 'SLIP_DEPOSIT', 'WITHDRAWAL']),
});

export type GeminiSupportOutput = z.infer<typeof GeminiSupportOutputSchema>;

const FORBIDDEN_FINANCIAL_APPROVAL_PATTERNS: RegExp[] = [
  /deposit\s+(is\s+|has\s+been\s+)?(approved|confirmed|completed|credited)/i,
  /withdrawal\s+(is\s+|has\s+been\s+)?(approved|confirmed|completed|paid|sent)/i,
  /payment\s+(is\s+|has\s+been\s+)?(verified|confirmed|successful|received)/i,
  /balance\s+(has\s+been\s+)?(added|credited|updated|increased)/i,
  /ငွေသွင်း(မှု)?\s*(အောင်မြင်|အတည်ပြု|ထည့်သွင်းပြီး)/i,
  /ငွေထုတ်(မှု)?\s*(အောင်မြင်|လွှဲပေးပြီး|အတည်ပြုပြီး)/i,
  /ငွေလွှဲ\s*(အောင်မြင်ပါသည်|လက်ခံရရှိပြီးပါပြီ|စစ်ဆေးပြီးပါပြီ)/i,
  /အကောင့်ထဲ(သို့)?\s*ငွေထည့်ပေးပြီး/i,
];

export function containsForbiddenFinancialCommitment(text: string): boolean {
  return FORBIDDEN_FINANCIAL_APPROVAL_PATTERNS.some((pattern) => pattern.test(text));
}
