import React, { createContext, useContext, useState, useEffect } from 'react';
import { en } from './translations/en';
import { ko } from './translations/ko';
import { zhCN } from './translations/zh-CN';
import { zhTW } from './translations/zh-TW';
import { ja } from './translations/ja';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { de } from './translations/de';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { ar } from './translations/ar';
import { hi } from './translations/hi';
import { id } from './translations/id';
import { tr } from './translations/tr';
import { vi } from './translations/vi';
import type { Translations } from './translations/en';

export type LangCode =
  | 'en' | 'ko' | 'zh-CN' | 'zh-TW' | 'ja'
  | 'es' | 'fr' | 'de' | 'pt' | 'ru'
  | 'ar' | 'hi' | 'id' | 'tr' | 'vi';

export interface LangMeta {
  code: LangCode;
  label: string;    // native name
  flag: string;     // emoji flag
  dir?: 'rtl';
}

export const LANGUAGES: LangMeta[] = [
  { code: 'en',    label: 'English',              flag: '🇺🇸' },
  { code: 'ko',    label: '한국어',                flag: '🇰🇷' },
  { code: 'zh-CN', label: '中文（简体）',          flag: '🇨🇳' },
  { code: 'zh-TW', label: '中文（繁體）',          flag: '🇹🇼' },
  { code: 'ja',    label: '日本語',                flag: '🇯🇵' },
  { code: 'es',    label: 'Español',              flag: '🇪🇸' },
  { code: 'fr',    label: 'Français',             flag: '🇫🇷' },
  { code: 'de',    label: 'Deutsch',              flag: '🇩🇪' },
  { code: 'pt',    label: 'Português',            flag: '🇧🇷' },
  { code: 'ru',    label: 'Русский',              flag: '🇷🇺' },
  { code: 'ar',    label: 'العربية',              flag: '🇸🇦', dir: 'rtl' },
  { code: 'hi',    label: 'हिन्दी',               flag: '🇮🇳' },
  { code: 'id',    label: 'Bahasa Indonesia',     flag: '🇮🇩' },
  { code: 'tr',    label: 'Türkçe',               flag: '🇹🇷' },
  { code: 'vi',    label: 'Tiếng Việt',           flag: '🇻🇳' },
];

const TRANSLATION_MAP: Record<LangCode, Translations> = {
  en, ko, 'zh-CN': zhCN, 'zh-TW': zhTW, ja,
  es, fr, de, pt, ru, ar, hi, id, tr, vi,
};

const STORAGE_KEY = 'lts-language';

interface I18nContextValue {
  lang: LangCode;
  setLang: (lang: LangCode) => void;
  t: Translations;
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'en',
  setLang: () => {},
  t: en,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<LangCode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as LangCode | null;
    return saved && TRANSLATION_MAP[saved] ? saved : 'en';
  });

  const setLang = (code: LangCode) => {
    setLangState(code);
    localStorage.setItem(STORAGE_KEY, code);
  };

  // Apply RTL direction for Arabic
  useEffect(() => {
    const meta = LANGUAGES.find(l => l.code === lang);
    document.documentElement.dir = meta?.dir ?? 'ltr';
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t: TRANSLATION_MAP[lang] }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
