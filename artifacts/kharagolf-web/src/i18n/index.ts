import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enCommon from "./locales/en/common.json";
import enNavigation from "./locales/en/navigation.json";
import enProfile from "./locales/en/profile.json";
import enTournaments from "./locales/en/tournaments.json";
import enLeagues from "./locales/en/leagues.json";
import enScoring from "./locales/en/scoring.json";
import enPublicBook from "./locales/en/publicBook.json";
import enAdmin from "./locales/en/admin.json";
import enPortal from "./locales/en/portal.json";
import enRegister from "./locales/en/register.json";
import enDashboard from "./locales/en/dashboard.json";

import hiCommon from "./locales/hi/common.json";
import hiNavigation from "./locales/hi/navigation.json";
import hiProfile from "./locales/hi/profile.json";
import hiTournaments from "./locales/hi/tournaments.json";
import hiLeagues from "./locales/hi/leagues.json";
import hiScoring from "./locales/hi/scoring.json";
import hiPublicBook from "./locales/hi/publicBook.json";
import hiAdmin from "./locales/hi/admin.json";
import hiPortal from "./locales/hi/portal.json";
import hiRegister from "./locales/hi/register.json";
import hiDashboard from "./locales/hi/dashboard.json";

import arCommon from "./locales/ar/common.json";
import arNavigation from "./locales/ar/navigation.json";
import arProfile from "./locales/ar/profile.json";
import arTournaments from "./locales/ar/tournaments.json";
import arLeagues from "./locales/ar/leagues.json";
import arScoring from "./locales/ar/scoring.json";
import arPublicBook from "./locales/ar/publicBook.json";
import arAdmin from "./locales/ar/admin.json";
import arPortal from "./locales/ar/portal.json";
import arRegister from "./locales/ar/register.json";
import arDashboard from "./locales/ar/dashboard.json";

import esCommon from "./locales/es/common.json";
import esNavigation from "./locales/es/navigation.json";
import esProfile from "./locales/es/profile.json";
import esTournaments from "./locales/es/tournaments.json";
import esLeagues from "./locales/es/leagues.json";
import esScoring from "./locales/es/scoring.json";
import esPublicBook from "./locales/es/publicBook.json";
import esAdmin from "./locales/es/admin.json";
import esPortal from "./locales/es/portal.json";
import esRegister from "./locales/es/register.json";
import esDashboard from "./locales/es/dashboard.json";

import frCommon from "./locales/fr/common.json";
import frNavigation from "./locales/fr/navigation.json";
import frProfile from "./locales/fr/profile.json";
import frTournaments from "./locales/fr/tournaments.json";
import frLeagues from "./locales/fr/leagues.json";
import frScoring from "./locales/fr/scoring.json";
import frPublicBook from "./locales/fr/publicBook.json";
import frAdmin from "./locales/fr/admin.json";
import frPortal from "./locales/fr/portal.json";
import frRegister from "./locales/fr/register.json";
import frDashboard from "./locales/fr/dashboard.json";

import deCommon from "./locales/de/common.json";
import deNavigation from "./locales/de/navigation.json";
import deProfile from "./locales/de/profile.json";
import deTournaments from "./locales/de/tournaments.json";
import deLeagues from "./locales/de/leagues.json";
import deScoring from "./locales/de/scoring.json";
import dePublicBook from "./locales/de/publicBook.json";
import deAdmin from "./locales/de/admin.json";
import dePortal from "./locales/de/portal.json";
import deRegister from "./locales/de/register.json";
import deDashboard from "./locales/de/dashboard.json";

import ptCommon from "./locales/pt/common.json";
import ptNavigation from "./locales/pt/navigation.json";
import ptProfile from "./locales/pt/profile.json";
import ptTournaments from "./locales/pt/tournaments.json";
import ptLeagues from "./locales/pt/leagues.json";
import ptScoring from "./locales/pt/scoring.json";
import ptPublicBook from "./locales/pt/publicBook.json";
import ptAdmin from "./locales/pt/admin.json";
import ptPortal from "./locales/pt/portal.json";
import ptRegister from "./locales/pt/register.json";
import ptDashboard from "./locales/pt/dashboard.json";

import jaCommon from "./locales/ja/common.json";
import jaNavigation from "./locales/ja/navigation.json";
import jaProfile from "./locales/ja/profile.json";
import jaTournaments from "./locales/ja/tournaments.json";
import jaLeagues from "./locales/ja/leagues.json";
import jaScoring from "./locales/ja/scoring.json";
import jaPublicBook from "./locales/ja/publicBook.json";
import jaAdmin from "./locales/ja/admin.json";
import jaPortal from "./locales/ja/portal.json";
import jaRegister from "./locales/ja/register.json";
import jaDashboard from "./locales/ja/dashboard.json";

import koCommon from "./locales/ko/common.json";
import koNavigation from "./locales/ko/navigation.json";
import koProfile from "./locales/ko/profile.json";
import koTournaments from "./locales/ko/tournaments.json";
import koLeagues from "./locales/ko/leagues.json";
import koScoring from "./locales/ko/scoring.json";
import koPublicBook from "./locales/ko/publicBook.json";
import koAdmin from "./locales/ko/admin.json";
import koPortal from "./locales/ko/portal.json";
import koRegister from "./locales/ko/register.json";
import koDashboard from "./locales/ko/dashboard.json";

import zhCommon from "./locales/zh/common.json";
import zhNavigation from "./locales/zh/navigation.json";
import zhProfile from "./locales/zh/profile.json";
import zhTournaments from "./locales/zh/tournaments.json";
import zhLeagues from "./locales/zh/leagues.json";
import zhScoring from "./locales/zh/scoring.json";
import zhPublicBook from "./locales/zh/publicBook.json";
import zhAdmin from "./locales/zh/admin.json";
import zhPortal from "./locales/zh/portal.json";
import zhRegister from "./locales/zh/register.json";
import zhDashboard from "./locales/zh/dashboard.json";

import thCommon from "./locales/th/common.json";
import thNavigation from "./locales/th/navigation.json";
import thProfile from "./locales/th/profile.json";
import thTournaments from "./locales/th/tournaments.json";
import thLeagues from "./locales/th/leagues.json";
import thScoring from "./locales/th/scoring.json";
import thPublicBook from "./locales/th/publicBook.json";
import thAdmin from "./locales/th/admin.json";
import thPortal from "./locales/th/portal.json";
import thRegister from "./locales/th/register.json";
import thDashboard from "./locales/th/dashboard.json";

import msCommon from "./locales/ms/common.json";
import msNavigation from "./locales/ms/navigation.json";
import msProfile from "./locales/ms/profile.json";
import msTournaments from "./locales/ms/tournaments.json";
import msLeagues from "./locales/ms/leagues.json";
import msScoring from "./locales/ms/scoring.json";
import msPublicBook from "./locales/ms/publicBook.json";
import msAdmin from "./locales/ms/admin.json";
import msPortal from "./locales/ms/portal.json";
import msRegister from "./locales/ms/register.json";
import msDashboard from "./locales/ms/dashboard.json";

import idCommon from "./locales/id/common.json";
import idNavigation from "./locales/id/navigation.json";
import idProfile from "./locales/id/profile.json";
import idTournaments from "./locales/id/tournaments.json";
import idLeagues from "./locales/id/leagues.json";
import idScoring from "./locales/id/scoring.json";
import idPublicBook from "./locales/id/publicBook.json";
import idAdmin from "./locales/id/admin.json";
import idPortal from "./locales/id/portal.json";
import idRegister from "./locales/id/register.json";
import idDashboard from "./locales/id/dashboard.json";

import viCommon from "./locales/vi/common.json";
import viNavigation from "./locales/vi/navigation.json";
import viProfile from "./locales/vi/profile.json";
import viTournaments from "./locales/vi/tournaments.json";
import viLeagues from "./locales/vi/leagues.json";
import viScoring from "./locales/vi/scoring.json";
import viPublicBook from "./locales/vi/publicBook.json";
import viAdmin from "./locales/vi/admin.json";
import viPortal from "./locales/vi/portal.json";
import viRegister from "./locales/vi/register.json";
import viDashboard from "./locales/vi/dashboard.json";

import filCommon from "./locales/fil/common.json";
import filNavigation from "./locales/fil/navigation.json";
import filProfile from "./locales/fil/profile.json";
import filTournaments from "./locales/fil/tournaments.json";
import filLeagues from "./locales/fil/leagues.json";
import filScoring from "./locales/fil/scoring.json";
import filPublicBook from "./locales/fil/publicBook.json";
import filAdmin from "./locales/fil/admin.json";
import filPortal from "./locales/fil/portal.json";
import filRegister from "./locales/fil/register.json";
import filDashboard from "./locales/fil/dashboard.json";

import swCommon from "./locales/sw/common.json";
import swNavigation from "./locales/sw/navigation.json";
import swProfile from "./locales/sw/profile.json";
import swTournaments from "./locales/sw/tournaments.json";
import swLeagues from "./locales/sw/leagues.json";
import swScoring from "./locales/sw/scoring.json";
import swPublicBook from "./locales/sw/publicBook.json";
import swAdmin from "./locales/sw/admin.json";
import swPortal from "./locales/sw/portal.json";
import swRegister from "./locales/sw/register.json";
import swDashboard from "./locales/sw/dashboard.json";

import afCommon from "./locales/af/common.json";
import afNavigation from "./locales/af/navigation.json";
import afProfile from "./locales/af/profile.json";
import afTournaments from "./locales/af/tournaments.json";
import afLeagues from "./locales/af/leagues.json";
import afScoring from "./locales/af/scoring.json";
import afPublicBook from "./locales/af/publicBook.json";
import afAdmin from "./locales/af/admin.json";
import afPortal from "./locales/af/portal.json";
import afRegister from "./locales/af/register.json";
import afDashboard from "./locales/af/dashboard.json";

import amCommon from "./locales/am/common.json";
import amNavigation from "./locales/am/navigation.json";
import amProfile from "./locales/am/profile.json";
import amTournaments from "./locales/am/tournaments.json";
import amLeagues from "./locales/am/leagues.json";
import amScoring from "./locales/am/scoring.json";
import amPublicBook from "./locales/am/publicBook.json";
import amAdmin from "./locales/am/admin.json";
import amPortal from "./locales/am/portal.json";
import amRegister from "./locales/am/register.json";
import amDashboard from "./locales/am/dashboard.json";

import haCommon from "./locales/ha/common.json";
import haNavigation from "./locales/ha/navigation.json";
import haProfile from "./locales/ha/profile.json";
import haTournaments from "./locales/ha/tournaments.json";
import haLeagues from "./locales/ha/leagues.json";
import haScoring from "./locales/ha/scoring.json";
import haPublicBook from "./locales/ha/publicBook.json";
import haAdmin from "./locales/ha/admin.json";
import haPortal from "./locales/ha/portal.json";
import haRegister from "./locales/ha/register.json";
import haDashboard from "./locales/ha/dashboard.json";

import zuCommon from "./locales/zu/common.json";
import zuNavigation from "./locales/zu/navigation.json";
import zuProfile from "./locales/zu/profile.json";
import zuTournaments from "./locales/zu/tournaments.json";
import zuLeagues from "./locales/zu/leagues.json";
import zuScoring from "./locales/zu/scoring.json";
import zuPublicBook from "./locales/zu/publicBook.json";
import zuAdmin from "./locales/zu/admin.json";
import zuPortal from "./locales/zu/portal.json";
import zuRegister from "./locales/zu/register.json";
import zuDashboard from "./locales/zu/dashboard.json";

import yoCommon from "./locales/yo/common.json";
import yoNavigation from "./locales/yo/navigation.json";
import yoProfile from "./locales/yo/profile.json";
import yoTournaments from "./locales/yo/tournaments.json";
import yoLeagues from "./locales/yo/leagues.json";
import yoScoring from "./locales/yo/scoring.json";
import yoPublicBook from "./locales/yo/publicBook.json";
import yoAdmin from "./locales/yo/admin.json";
import yoPortal from "./locales/yo/portal.json";
import yoRegister from "./locales/yo/register.json";
import yoDashboard from "./locales/yo/dashboard.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English", dir: "ltr", flag: "🇬🇧" },
  { code: "hi", name: "हिंदी", dir: "ltr", flag: "🇮🇳" },
  { code: "ar", name: "العربية", dir: "rtl", flag: "🇸🇦" },
  { code: "es", name: "Español", dir: "ltr", flag: "🇪🇸" },
  { code: "fr", name: "Français", dir: "ltr", flag: "🇫🇷" },
  { code: "de", name: "Deutsch", dir: "ltr", flag: "🇩🇪" },
  { code: "pt", name: "Português", dir: "ltr", flag: "🇧🇷" },
  { code: "ja", name: "日本語", dir: "ltr", flag: "🇯🇵" },
  { code: "ko", name: "한국어", dir: "ltr", flag: "🇰🇷" },
  { code: "zh", name: "中文", dir: "ltr", flag: "🇨🇳" },
  { code: "th", name: "ภาษาไทย", dir: "ltr", flag: "🇹🇭" },
  { code: "ms", name: "Bahasa Melayu", dir: "ltr", flag: "🇲🇾" },
  { code: "id", name: "Bahasa Indonesia", dir: "ltr", flag: "🇮🇩" },
  { code: "vi", name: "Tiếng Việt", dir: "ltr", flag: "🇻🇳" },
  { code: "fil", name: "Filipino", dir: "ltr", flag: "🇵🇭" },
  { code: "sw", name: "Kiswahili", dir: "ltr", flag: "🇰🇪" },
  { code: "af", name: "Afrikaans", dir: "ltr", flag: "🇿🇦" },
  { code: "am", name: "አማርኛ", dir: "ltr", flag: "🇪🇹" },
  { code: "ha", name: "Hausa", dir: "ltr", flag: "🇳🇬" },
  { code: "zu", name: "isiZulu", dir: "ltr", flag: "🇿🇦" },
  { code: "yo", name: "Yorùbá", dir: "ltr", flag: "🇳🇬" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export function applyLanguageDirection(lang: string) {
  const langConfig = SUPPORTED_LANGUAGES.find((l) => l.code === lang);
  const dir = langConfig?.dir ?? "ltr";
  document.documentElement.dir = dir;
  document.documentElement.lang = lang;
  localStorage.setItem("i18n_lang", lang);
}

export function getSavedLanguage(): string {
  return localStorage.getItem("i18n_lang") ?? "en";
}

const LOCALE_MAP: Record<string, string> = {
  en: "en-IN",
  hi: "hi-IN",
  ar: "ar-AE",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  pt: "pt-BR",
  ja: "ja-JP",
  ko: "ko-KR",
  zh: "zh-CN",
  th: "th-TH",
  ms: "ms-MY",
  id: "id-ID",
  vi: "vi-VN",
  fil: "fil-PH",
  sw: "sw-KE",
  af: "af-ZA",
  am: "am-ET",
  ha: "ha-NG",
  zu: "zu-ZA",
  yo: "yo-NG",
};

export function getLocale(lang?: string): string {
  const l = lang ?? i18n.language ?? "en";
  return LOCALE_MAP[l] ?? l;
}

i18n.use(initReactI18next).init({
  lng: getSavedLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: ["common", "navigation", "profile", "tournaments", "leagues", "scoring", "publicBook", "admin", "portal", "register", "dashboard"],
  resources: {
    en: {
      common: enCommon,
      navigation: enNavigation,
      profile: enProfile,
      tournaments: enTournaments,
      leagues: enLeagues,
      scoring: enScoring,
      publicBook: enPublicBook,
      admin: enAdmin,
      portal: enPortal,
      register: enRegister,
      dashboard: enDashboard,
    },
    hi: {
      common: hiCommon,
      navigation: hiNavigation,
      profile: hiProfile,
      tournaments: hiTournaments,
      leagues: hiLeagues,
      scoring: hiScoring,
      publicBook: hiPublicBook,
      admin: hiAdmin,
      portal: hiPortal,
      register: hiRegister,
      dashboard: hiDashboard,
    },
    ar: {
      common: arCommon,
      navigation: arNavigation,
      profile: arProfile,
      tournaments: arTournaments,
      leagues: arLeagues,
      scoring: arScoring,
      publicBook: arPublicBook,
      admin: arAdmin,
      portal: arPortal,
      register: arRegister,
      dashboard: arDashboard,
    },
    es: {
      common: esCommon,
      navigation: esNavigation,
      profile: esProfile,
      tournaments: esTournaments,
      leagues: esLeagues,
      scoring: esScoring,
      publicBook: esPublicBook,
      admin: esAdmin,
      portal: esPortal,
      register: esRegister,
      dashboard: esDashboard,
    },
    fr: {
      common: frCommon,
      navigation: frNavigation,
      profile: frProfile,
      tournaments: frTournaments,
      leagues: frLeagues,
      scoring: frScoring,
      publicBook: frPublicBook,
      admin: frAdmin,
      portal: frPortal,
      register: frRegister,
      dashboard: frDashboard,
    },
    de: {
      common: deCommon,
      navigation: deNavigation,
      profile: deProfile,
      tournaments: deTournaments,
      leagues: deLeagues,
      scoring: deScoring,
      publicBook: dePublicBook,
      admin: deAdmin,
      portal: dePortal,
      register: deRegister,
      dashboard: deDashboard,
    },
    pt: {
      common: ptCommon,
      navigation: ptNavigation,
      profile: ptProfile,
      tournaments: ptTournaments,
      leagues: ptLeagues,
      scoring: ptScoring,
      publicBook: ptPublicBook,
      admin: ptAdmin,
      portal: ptPortal,
      register: ptRegister,
      dashboard: ptDashboard,
    },
    ja: {
      common: jaCommon,
      navigation: jaNavigation,
      profile: jaProfile,
      tournaments: jaTournaments,
      leagues: jaLeagues,
      scoring: jaScoring,
      publicBook: jaPublicBook,
      admin: jaAdmin,
      portal: jaPortal,
      register: jaRegister,
      dashboard: jaDashboard,
    },
    ko: {
      common: koCommon,
      navigation: koNavigation,
      profile: koProfile,
      tournaments: koTournaments,
      leagues: koLeagues,
      scoring: koScoring,
      publicBook: koPublicBook,
      admin: koAdmin,
      portal: koPortal,
      register: koRegister,
      dashboard: koDashboard,
    },
    zh: {
      common: zhCommon,
      navigation: zhNavigation,
      profile: zhProfile,
      tournaments: zhTournaments,
      leagues: zhLeagues,
      scoring: zhScoring,
      publicBook: zhPublicBook,
      admin: zhAdmin,
      portal: zhPortal,
      register: zhRegister,
      dashboard: zhDashboard,
    },
    th: {
      common: thCommon,
      navigation: thNavigation,
      profile: thProfile,
      tournaments: thTournaments,
      leagues: thLeagues,
      scoring: thScoring,
      publicBook: thPublicBook,
      admin: thAdmin,
      portal: thPortal,
      register: thRegister,
      dashboard: thDashboard,
    },
    ms: {
      common: msCommon,
      navigation: msNavigation,
      profile: msProfile,
      tournaments: msTournaments,
      leagues: msLeagues,
      scoring: msScoring,
      publicBook: msPublicBook,
      admin: msAdmin,
      portal: msPortal,
      register: msRegister,
      dashboard: msDashboard,
    },
    id: {
      common: idCommon,
      navigation: idNavigation,
      profile: idProfile,
      tournaments: idTournaments,
      leagues: idLeagues,
      scoring: idScoring,
      publicBook: idPublicBook,
      admin: idAdmin,
      portal: idPortal,
      register: idRegister,
      dashboard: idDashboard,
    },
    vi: {
      common: viCommon,
      navigation: viNavigation,
      profile: viProfile,
      tournaments: viTournaments,
      leagues: viLeagues,
      scoring: viScoring,
      publicBook: viPublicBook,
      admin: viAdmin,
      portal: viPortal,
      register: viRegister,
      dashboard: viDashboard,
    },
    fil: {
      common: filCommon,
      navigation: filNavigation,
      profile: filProfile,
      tournaments: filTournaments,
      leagues: filLeagues,
      scoring: filScoring,
      publicBook: filPublicBook,
      admin: filAdmin,
      portal: filPortal,
      register: filRegister,
      dashboard: filDashboard,
    },
    sw: {
      common: swCommon,
      navigation: swNavigation,
      profile: swProfile,
      tournaments: swTournaments,
      leagues: swLeagues,
      scoring: swScoring,
      publicBook: swPublicBook,
      admin: swAdmin,
      portal: swPortal,
      register: swRegister,
      dashboard: swDashboard,
    },
    af: {
      common: afCommon,
      navigation: afNavigation,
      profile: afProfile,
      tournaments: afTournaments,
      leagues: afLeagues,
      scoring: afScoring,
      publicBook: afPublicBook,
      admin: afAdmin,
      portal: afPortal,
      register: afRegister,
      dashboard: afDashboard,
    },
    am: {
      common: amCommon,
      navigation: amNavigation,
      profile: amProfile,
      tournaments: amTournaments,
      leagues: amLeagues,
      scoring: amScoring,
      publicBook: amPublicBook,
      admin: amAdmin,
      portal: amPortal,
      register: amRegister,
      dashboard: amDashboard,
    },
    ha: {
      common: haCommon,
      navigation: haNavigation,
      profile: haProfile,
      tournaments: haTournaments,
      leagues: haLeagues,
      scoring: haScoring,
      publicBook: haPublicBook,
      admin: haAdmin,
      portal: haPortal,
      register: haRegister,
      dashboard: haDashboard,
    },
    zu: {
      common: zuCommon,
      navigation: zuNavigation,
      profile: zuProfile,
      tournaments: zuTournaments,
      leagues: zuLeagues,
      scoring: zuScoring,
      publicBook: zuPublicBook,
      admin: zuAdmin,
      portal: zuPortal,
      register: zuRegister,
      dashboard: zuDashboard,
    },
    yo: {
      common: yoCommon,
      navigation: yoNavigation,
      profile: yoProfile,
      tournaments: yoTournaments,
      leagues: yoLeagues,
      scoring: yoScoring,
      publicBook: yoPublicBook,
      admin: yoAdmin,
      portal: yoPortal,
      register: yoRegister,
      dashboard: yoDashboard,
    },
  },
  interpolation: {
    escapeValue: false,
  },
});

applyLanguageDirection(i18n.language);

i18n.on("languageChanged", (lang) => {
  applyLanguageDirection(lang);
});

export default i18n;
