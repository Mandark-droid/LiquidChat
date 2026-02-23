import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Chat, ChatSettings } from '../types';

const CHATS_KEY = '@liquid_chats';
const SETTINGS_KEY = '@liquid_settings';

export const storage = {
  async getAllChats(): Promise<Chat[]> {
    try {
      const chatsJson = await AsyncStorage.getItem(CHATS_KEY);
      if (chatsJson) {
        return JSON.parse(chatsJson);
      }
      return [];
    } catch (error) {
      console.error('Error loading chats:', error);
      return [];
    }
  },

  async getChat(chatId: string): Promise<Chat | null> {
    try {
      const chats = await this.getAllChats();
      return chats.find((chat) => chat.id === chatId) || null;
    } catch (error) {
      console.error('Error loading chat:', error);
      return null;
    }
  },

  async saveChat(chat: Chat): Promise<void> {
    try {
      const chats = await this.getAllChats();
      const existingIndex = chats.findIndex((c) => c.id === chat.id);
      if (existingIndex >= 0) {
        chats[existingIndex] = chat;
      } else {
        chats.unshift(chat);
      }
      await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(chats));
    } catch (error) {
      console.error('Error saving chat:', error);
    }
  },

  async deleteChat(chatId: string): Promise<void> {
    try {
      const chats = await this.getAllChats();
      const filteredChats = chats.filter((chat) => chat.id !== chatId);
      await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(filteredChats));
    } catch (error) {
      console.error('Error deleting chat:', error);
    }
  },

  async getSettings(): Promise<ChatSettings | null> {
    try {
      const settingsJson = await AsyncStorage.getItem(SETTINGS_KEY);
      if (settingsJson) {
        return JSON.parse(settingsJson);
      }
      return null;
    } catch (error) {
      console.error('Error loading settings:', error);
      return null;
    }
  },

  async saveSettings(settings: ChatSettings): Promise<void> {
    try {
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  },
};
