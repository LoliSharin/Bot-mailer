export interface TelegramUpdateDto {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  voice?: unknown;
  photo?: unknown[];
  document?: unknown;
  video?: unknown;
  chat: {
    id: number;
    type: string;
  };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  reply_to_message?: {
    message_id: number;
    text?: string;
  };
}
