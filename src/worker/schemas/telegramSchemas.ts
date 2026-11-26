import { z } from 'zod';

export const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().min(1).max(256),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

export const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
  username: z.string().optional(),
});

export const TelegramPhotoSizeSchema = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  file_size: z.number().int().nonnegative().optional(),
});

export const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number().int(),
  text: z.string().max(4096).optional(),
  caption: z.string().max(1024).optional(),
  photo: z.array(TelegramPhotoSizeSchema).min(1).optional(),
  migrate_to_chat_id: z.number().int().optional(),
});

export const TelegramCallbackQuerySchema = z.object({
  id: z.string().min(1),
  from: TelegramUserSchema,
  message: TelegramMessageSchema.optional(),
  data: z.string().min(1).max(64).optional(),
});

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: TelegramMessageSchema.optional(),
  callback_query: TelegramCallbackQuerySchema.optional(),
});

export type TelegramUser = z.infer<typeof TelegramUserSchema>;
export type TelegramChat = z.infer<typeof TelegramChatSchema>;
export type TelegramPhotoSize = z.infer<typeof TelegramPhotoSizeSchema>;
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof TelegramCallbackQuerySchema>;
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export function selectLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize {
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new Error('PHOTO_ARRAY_EMPTY');
  }
  const sorted = [...photos].sort((a, b) => {
    const scoreA = a.file_size ?? a.width * a.height;
    const scoreB = b.file_size ?? b.width * b.height;
    return scoreB - scoreA;
  });
  return sorted[0];
}
