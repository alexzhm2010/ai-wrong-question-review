"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { translations, type Language } from "@/lib/translations";

const STORAGE_KEY = "app-language";

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: typeof translations["en"];
}

const Context = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("zh");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") setLanguageState(saved);
  }, []);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    window.localStorage.setItem(STORAGE_KEY, lang);
  }, []);

  const value = useMemo<LanguageState>(
    () => ({ language, setLanguage, t: translations[language] }),
    [language, setLanguage],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLanguage(): LanguageState {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useLanguage 必须在 LanguageProvider 内使用");
  return ctx;
}
