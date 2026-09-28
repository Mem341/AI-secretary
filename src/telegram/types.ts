// Minimal subset of the Telegram Bot API types that the bot uses.

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
  mime_type?: string;
  duration?: number;
  file_name?: string;
}

export type TgMessageOrigin =
  | { type: "user"; date: number; sender_user: TgUser }
  | { type: "hidden_user"; date: number; sender_user_name: string }
  | { type: "chat"; date: number; sender_chat: { title?: string } }
  | { type: "channel"; date: number; chat: { title?: string } };

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  forward_origin?: TgMessageOrigin;
  reply_to_message?: TgMessage;
  voice?: TgFile;
  audio?: TgFile;
  photo?: TgPhotoSize[];
  document?: TgFile;
  contact?: { phone_number: string; user_id?: number };
  media_group_id?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineButton[][];
