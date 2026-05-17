import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { I18nManager } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ExpoLocalization from "expo-localization";

import enCommon from "./locales/en/common.json";
import enNavigation from "./locales/en/navigation.json";
import enProfile from "./locales/en/profile.json";
import enTournaments from "./locales/en/tournaments.json";
import enScoring from "./locales/en/scoring.json";
import enRange from "./locales/en/range.json";
import enTeeBookings from "./locales/en/teeBookings.json";
import enHome from "./locales/en/home.json";
import enShop from "./locales/en/shop.json";
import enLeaderboard from "./locales/en/leaderboard.json";
import enMatchPlay from "./locales/en/matchPlay.json";
import enUpdates from "./locales/en/updates.json";
import enFantasy from "./locales/en/fantasy.json";
import enOrder from "./locales/en/order.json";
import enHandicapCommittee from "./locales/en/handicapCommittee.json";
import enNotifications from "./locales/en/notifications.json";
import enClubSettings from "./locales/en/clubSettings.json";
import enStats from "./locales/en/stats.json";
import enAuth from "./locales/en/auth.json";

import hiCommon from "./locales/hi/common.json";
import hiNavigation from "./locales/hi/navigation.json";
import hiProfile from "./locales/hi/profile.json";
import hiTournaments from "./locales/hi/tournaments.json";
import hiScoring from "./locales/hi/scoring.json";
import hiRange from "./locales/hi/range.json";
import hiTeeBookings from "./locales/hi/teeBookings.json";
import hiHome from "./locales/hi/home.json";
import hiShop from "./locales/hi/shop.json";
import hiLeaderboard from "./locales/hi/leaderboard.json";
import hiMatchPlay from "./locales/hi/matchPlay.json";
import hiUpdates from "./locales/hi/updates.json";
import hiFantasy from "./locales/hi/fantasy.json";
import hiOrder from "./locales/hi/order.json";
import hiHandicapCommittee from "./locales/hi/handicapCommittee.json";
import hiNotifications from "./locales/hi/notifications.json";
import hiClubSettings from "./locales/hi/clubSettings.json";
import hiStats from "./locales/hi/stats.json";
import hiAuth from "./locales/hi/auth.json";

import arCommon from "./locales/ar/common.json";
import arNavigation from "./locales/ar/navigation.json";
import arProfile from "./locales/ar/profile.json";
import arTournaments from "./locales/ar/tournaments.json";
import arScoring from "./locales/ar/scoring.json";
import arRange from "./locales/ar/range.json";
import arTeeBookings from "./locales/ar/teeBookings.json";
import arHome from "./locales/ar/home.json";
import arShop from "./locales/ar/shop.json";
import arLeaderboard from "./locales/ar/leaderboard.json";
import arMatchPlay from "./locales/ar/matchPlay.json";
import arUpdates from "./locales/ar/updates.json";
import arFantasy from "./locales/ar/fantasy.json";
import arOrder from "./locales/ar/order.json";
import arHandicapCommittee from "./locales/ar/handicapCommittee.json";
import arNotifications from "./locales/ar/notifications.json";
import arClubSettings from "./locales/ar/clubSettings.json";
import arStats from "./locales/ar/stats.json";
import arAuth from "./locales/ar/auth.json";

import esCommon from "./locales/es/common.json";
import esNavigation from "./locales/es/navigation.json";
import esProfile from "./locales/es/profile.json";
import esTournaments from "./locales/es/tournaments.json";
import esScoring from "./locales/es/scoring.json";
import esRange from "./locales/es/range.json";
import esTeeBookings from "./locales/es/teeBookings.json";
import esHome from "./locales/es/home.json";
import esShop from "./locales/es/shop.json";
import esLeaderboard from "./locales/es/leaderboard.json";
import esMatchPlay from "./locales/es/matchPlay.json";
import esUpdates from "./locales/es/updates.json";
import esFantasy from "./locales/es/fantasy.json";
import esOrder from "./locales/es/order.json";
import esHandicapCommittee from "./locales/es/handicapCommittee.json";
import esNotifications from "./locales/es/notifications.json";
import esClubSettings from "./locales/es/clubSettings.json";
import esStats from "./locales/es/stats.json";
import esAuth from "./locales/es/auth.json";

import frCommon from "./locales/fr/common.json";
import frNavigation from "./locales/fr/navigation.json";
import frProfile from "./locales/fr/profile.json";
import frTournaments from "./locales/fr/tournaments.json";
import frScoring from "./locales/fr/scoring.json";
import frRange from "./locales/fr/range.json";
import frTeeBookings from "./locales/fr/teeBookings.json";
import frHome from "./locales/fr/home.json";
import frShop from "./locales/fr/shop.json";
import frLeaderboard from "./locales/fr/leaderboard.json";
import frMatchPlay from "./locales/fr/matchPlay.json";
import frUpdates from "./locales/fr/updates.json";
import frFantasy from "./locales/fr/fantasy.json";
import frOrder from "./locales/fr/order.json";
import frHandicapCommittee from "./locales/fr/handicapCommittee.json";
import frNotifications from "./locales/fr/notifications.json";
import frClubSettings from "./locales/fr/clubSettings.json";
import frStats from "./locales/fr/stats.json";
import frAuth from "./locales/fr/auth.json";

import deCommon from "./locales/de/common.json";
import deNavigation from "./locales/de/navigation.json";
import deProfile from "./locales/de/profile.json";
import deTournaments from "./locales/de/tournaments.json";
import deScoring from "./locales/de/scoring.json";
import deRange from "./locales/de/range.json";
import deTeeBookings from "./locales/de/teeBookings.json";
import deHome from "./locales/de/home.json";
import deShop from "./locales/de/shop.json";
import deLeaderboard from "./locales/de/leaderboard.json";
import deMatchPlay from "./locales/de/matchPlay.json";
import deUpdates from "./locales/de/updates.json";
import deFantasy from "./locales/de/fantasy.json";
import deOrder from "./locales/de/order.json";
import deHandicapCommittee from "./locales/de/handicapCommittee.json";
import deNotifications from "./locales/de/notifications.json";
import deClubSettings from "./locales/de/clubSettings.json";
import deStats from "./locales/de/stats.json";
import deAuth from "./locales/de/auth.json";

import ptCommon from "./locales/pt/common.json";
import ptNavigation from "./locales/pt/navigation.json";
import ptProfile from "./locales/pt/profile.json";
import ptTournaments from "./locales/pt/tournaments.json";
import ptScoring from "./locales/pt/scoring.json";
import ptRange from "./locales/pt/range.json";
import ptTeeBookings from "./locales/pt/teeBookings.json";
import ptHome from "./locales/pt/home.json";
import ptShop from "./locales/pt/shop.json";
import ptLeaderboard from "./locales/pt/leaderboard.json";
import ptMatchPlay from "./locales/pt/matchPlay.json";
import ptUpdates from "./locales/pt/updates.json";
import ptFantasy from "./locales/pt/fantasy.json";
import ptOrder from "./locales/pt/order.json";
import ptHandicapCommittee from "./locales/pt/handicapCommittee.json";
import ptNotifications from "./locales/pt/notifications.json";
import ptClubSettings from "./locales/pt/clubSettings.json";
import ptStats from "./locales/pt/stats.json";
import ptAuth from "./locales/pt/auth.json";

import jaCommon from "./locales/ja/common.json";
import jaNavigation from "./locales/ja/navigation.json";
import jaProfile from "./locales/ja/profile.json";
import jaTournaments from "./locales/ja/tournaments.json";
import jaScoring from "./locales/ja/scoring.json";
import jaRange from "./locales/ja/range.json";
import jaTeeBookings from "./locales/ja/teeBookings.json";
import jaHome from "./locales/ja/home.json";
import jaShop from "./locales/ja/shop.json";
import jaLeaderboard from "./locales/ja/leaderboard.json";
import jaMatchPlay from "./locales/ja/matchPlay.json";
import jaUpdates from "./locales/ja/updates.json";
import jaFantasy from "./locales/ja/fantasy.json";
import jaOrder from "./locales/ja/order.json";
import jaHandicapCommittee from "./locales/ja/handicapCommittee.json";
import jaNotifications from "./locales/ja/notifications.json";
import jaClubSettings from "./locales/ja/clubSettings.json";
import jaStats from "./locales/ja/stats.json";
import jaAuth from "./locales/ja/auth.json";

import koCommon from "./locales/ko/common.json";
import koNavigation from "./locales/ko/navigation.json";
import koProfile from "./locales/ko/profile.json";
import koTournaments from "./locales/ko/tournaments.json";
import koScoring from "./locales/ko/scoring.json";
import koRange from "./locales/ko/range.json";
import koTeeBookings from "./locales/ko/teeBookings.json";
import koHome from "./locales/ko/home.json";
import koShop from "./locales/ko/shop.json";
import koLeaderboard from "./locales/ko/leaderboard.json";
import koMatchPlay from "./locales/ko/matchPlay.json";
import koUpdates from "./locales/ko/updates.json";
import koFantasy from "./locales/ko/fantasy.json";
import koOrder from "./locales/ko/order.json";
import koHandicapCommittee from "./locales/ko/handicapCommittee.json";
import koNotifications from "./locales/ko/notifications.json";
import koClubSettings from "./locales/ko/clubSettings.json";
import koStats from "./locales/ko/stats.json";
import koAuth from "./locales/ko/auth.json";

import zhCommon from "./locales/zh/common.json";
import zhNavigation from "./locales/zh/navigation.json";
import zhProfile from "./locales/zh/profile.json";
import zhTournaments from "./locales/zh/tournaments.json";
import zhScoring from "./locales/zh/scoring.json";
import zhRange from "./locales/zh/range.json";
import zhTeeBookings from "./locales/zh/teeBookings.json";
import zhHome from "./locales/zh/home.json";
import zhShop from "./locales/zh/shop.json";
import zhLeaderboard from "./locales/zh/leaderboard.json";
import zhMatchPlay from "./locales/zh/matchPlay.json";
import zhUpdates from "./locales/zh/updates.json";
import zhFantasy from "./locales/zh/fantasy.json";
import zhOrder from "./locales/zh/order.json";
import zhHandicapCommittee from "./locales/zh/handicapCommittee.json";
import zhNotifications from "./locales/zh/notifications.json";
import zhClubSettings from "./locales/zh/clubSettings.json";
import zhStats from "./locales/zh/stats.json";
import zhAuth from "./locales/zh/auth.json";

import thCommon from "./locales/th/common.json";
import thNavigation from "./locales/th/navigation.json";
import thProfile from "./locales/th/profile.json";
import thTournaments from "./locales/th/tournaments.json";
import thScoring from "./locales/th/scoring.json";
import thRange from "./locales/th/range.json";
import thTeeBookings from "./locales/th/teeBookings.json";
import thHome from "./locales/th/home.json";
import thShop from "./locales/th/shop.json";
import thLeaderboard from "./locales/th/leaderboard.json";
import thMatchPlay from "./locales/th/matchPlay.json";
import thUpdates from "./locales/th/updates.json";
import thFantasy from "./locales/th/fantasy.json";
import thOrder from "./locales/th/order.json";
import thHandicapCommittee from "./locales/th/handicapCommittee.json";
import thNotifications from "./locales/th/notifications.json";
import thClubSettings from "./locales/th/clubSettings.json";
import thStats from "./locales/th/stats.json";
import thAuth from "./locales/th/auth.json";

import msCommon from "./locales/ms/common.json";
import msNavigation from "./locales/ms/navigation.json";
import msProfile from "./locales/ms/profile.json";
import msTournaments from "./locales/ms/tournaments.json";
import msScoring from "./locales/ms/scoring.json";
import msRange from "./locales/ms/range.json";
import msTeeBookings from "./locales/ms/teeBookings.json";
import msHome from "./locales/ms/home.json";
import msShop from "./locales/ms/shop.json";
import msLeaderboard from "./locales/ms/leaderboard.json";
import msMatchPlay from "./locales/ms/matchPlay.json";
import msUpdates from "./locales/ms/updates.json";
import msFantasy from "./locales/ms/fantasy.json";
import msOrder from "./locales/ms/order.json";
import msHandicapCommittee from "./locales/ms/handicapCommittee.json";
import msNotifications from "./locales/ms/notifications.json";
import msClubSettings from "./locales/ms/clubSettings.json";
import msStats from "./locales/ms/stats.json";
import msAuth from "./locales/ms/auth.json";

import idCommon from "./locales/id/common.json";
import idNavigation from "./locales/id/navigation.json";
import idProfile from "./locales/id/profile.json";
import idTournaments from "./locales/id/tournaments.json";
import idScoring from "./locales/id/scoring.json";
import idRange from "./locales/id/range.json";
import idTeeBookings from "./locales/id/teeBookings.json";
import idHome from "./locales/id/home.json";
import idShop from "./locales/id/shop.json";
import idLeaderboard from "./locales/id/leaderboard.json";
import idMatchPlay from "./locales/id/matchPlay.json";
import idUpdates from "./locales/id/updates.json";
import idFantasy from "./locales/id/fantasy.json";
import idOrder from "./locales/id/order.json";
import idHandicapCommittee from "./locales/id/handicapCommittee.json";
import idNotifications from "./locales/id/notifications.json";
import idClubSettings from "./locales/id/clubSettings.json";
import idStats from "./locales/id/stats.json";
import idAuth from "./locales/id/auth.json";

import viCommon from "./locales/vi/common.json";
import viNavigation from "./locales/vi/navigation.json";
import viProfile from "./locales/vi/profile.json";
import viTournaments from "./locales/vi/tournaments.json";
import viScoring from "./locales/vi/scoring.json";
import viRange from "./locales/vi/range.json";
import viTeeBookings from "./locales/vi/teeBookings.json";
import viHome from "./locales/vi/home.json";
import viShop from "./locales/vi/shop.json";
import viLeaderboard from "./locales/vi/leaderboard.json";
import viMatchPlay from "./locales/vi/matchPlay.json";
import viUpdates from "./locales/vi/updates.json";
import viFantasy from "./locales/vi/fantasy.json";
import viOrder from "./locales/vi/order.json";
import viHandicapCommittee from "./locales/vi/handicapCommittee.json";
import viNotifications from "./locales/vi/notifications.json";
import viClubSettings from "./locales/vi/clubSettings.json";
import viStats from "./locales/vi/stats.json";
import viAuth from "./locales/vi/auth.json";

import filCommon from "./locales/fil/common.json";
import filNavigation from "./locales/fil/navigation.json";
import filProfile from "./locales/fil/profile.json";
import filTournaments from "./locales/fil/tournaments.json";
import filScoring from "./locales/fil/scoring.json";
import filRange from "./locales/fil/range.json";
import filTeeBookings from "./locales/fil/teeBookings.json";
import filHome from "./locales/fil/home.json";
import filShop from "./locales/fil/shop.json";
import filLeaderboard from "./locales/fil/leaderboard.json";
import filMatchPlay from "./locales/fil/matchPlay.json";
import filUpdates from "./locales/fil/updates.json";
import filFantasy from "./locales/fil/fantasy.json";
import filOrder from "./locales/fil/order.json";
import filHandicapCommittee from "./locales/fil/handicapCommittee.json";
import filNotifications from "./locales/fil/notifications.json";
import filClubSettings from "./locales/fil/clubSettings.json";
import filStats from "./locales/fil/stats.json";
import filAuth from "./locales/fil/auth.json";

import swCommon from "./locales/sw/common.json";
import swNavigation from "./locales/sw/navigation.json";
import swProfile from "./locales/sw/profile.json";
import swTournaments from "./locales/sw/tournaments.json";
import swScoring from "./locales/sw/scoring.json";
import swRange from "./locales/sw/range.json";
import swTeeBookings from "./locales/sw/teeBookings.json";
import swHome from "./locales/sw/home.json";
import swShop from "./locales/sw/shop.json";
import swLeaderboard from "./locales/sw/leaderboard.json";
import swMatchPlay from "./locales/sw/matchPlay.json";
import swUpdates from "./locales/sw/updates.json";
import swFantasy from "./locales/sw/fantasy.json";
import swOrder from "./locales/sw/order.json";
import swHandicapCommittee from "./locales/sw/handicapCommittee.json";
import swNotifications from "./locales/sw/notifications.json";
import swClubSettings from "./locales/sw/clubSettings.json";
import swStats from "./locales/sw/stats.json";
import swAuth from "./locales/sw/auth.json";

import afCommon from "./locales/af/common.json";
import afNavigation from "./locales/af/navigation.json";
import afProfile from "./locales/af/profile.json";
import afTournaments from "./locales/af/tournaments.json";
import afScoring from "./locales/af/scoring.json";
import afRange from "./locales/af/range.json";
import afTeeBookings from "./locales/af/teeBookings.json";
import afHome from "./locales/af/home.json";
import afShop from "./locales/af/shop.json";
import afLeaderboard from "./locales/af/leaderboard.json";
import afMatchPlay from "./locales/af/matchPlay.json";
import afUpdates from "./locales/af/updates.json";
import afFantasy from "./locales/af/fantasy.json";
import afOrder from "./locales/af/order.json";
import afHandicapCommittee from "./locales/af/handicapCommittee.json";
import afNotifications from "./locales/af/notifications.json";
import afClubSettings from "./locales/af/clubSettings.json";
import afStats from "./locales/af/stats.json";
import afAuth from "./locales/af/auth.json";

import amCommon from "./locales/am/common.json";
import amNavigation from "./locales/am/navigation.json";
import amProfile from "./locales/am/profile.json";
import amTournaments from "./locales/am/tournaments.json";
import amScoring from "./locales/am/scoring.json";
import amRange from "./locales/am/range.json";
import amTeeBookings from "./locales/am/teeBookings.json";
import amHome from "./locales/am/home.json";
import amShop from "./locales/am/shop.json";
import amLeaderboard from "./locales/am/leaderboard.json";
import amMatchPlay from "./locales/am/matchPlay.json";
import amUpdates from "./locales/am/updates.json";
import amFantasy from "./locales/am/fantasy.json";
import amOrder from "./locales/am/order.json";
import amHandicapCommittee from "./locales/am/handicapCommittee.json";
import amNotifications from "./locales/am/notifications.json";
import amClubSettings from "./locales/am/clubSettings.json";
import amStats from "./locales/am/stats.json";
import amAuth from "./locales/am/auth.json";

import haCommon from "./locales/ha/common.json";
import haNavigation from "./locales/ha/navigation.json";
import haProfile from "./locales/ha/profile.json";
import haTournaments from "./locales/ha/tournaments.json";
import haScoring from "./locales/ha/scoring.json";
import haRange from "./locales/ha/range.json";
import haTeeBookings from "./locales/ha/teeBookings.json";
import haHome from "./locales/ha/home.json";
import haShop from "./locales/ha/shop.json";
import haLeaderboard from "./locales/ha/leaderboard.json";
import haMatchPlay from "./locales/ha/matchPlay.json";
import haUpdates from "./locales/ha/updates.json";
import haFantasy from "./locales/ha/fantasy.json";
import haOrder from "./locales/ha/order.json";
import haHandicapCommittee from "./locales/ha/handicapCommittee.json";
import haNotifications from "./locales/ha/notifications.json";
import haClubSettings from "./locales/ha/clubSettings.json";
import haStats from "./locales/ha/stats.json";
import haAuth from "./locales/ha/auth.json";

import zuCommon from "./locales/zu/common.json";
import zuNavigation from "./locales/zu/navigation.json";
import zuProfile from "./locales/zu/profile.json";
import zuTournaments from "./locales/zu/tournaments.json";
import zuScoring from "./locales/zu/scoring.json";
import zuRange from "./locales/zu/range.json";
import zuTeeBookings from "./locales/zu/teeBookings.json";
import zuHome from "./locales/zu/home.json";
import zuShop from "./locales/zu/shop.json";
import zuLeaderboard from "./locales/zu/leaderboard.json";
import zuMatchPlay from "./locales/zu/matchPlay.json";
import zuUpdates from "./locales/zu/updates.json";
import zuFantasy from "./locales/zu/fantasy.json";
import zuOrder from "./locales/zu/order.json";
import zuHandicapCommittee from "./locales/zu/handicapCommittee.json";
import zuNotifications from "./locales/zu/notifications.json";
import zuClubSettings from "./locales/zu/clubSettings.json";
import zuStats from "./locales/zu/stats.json";
import zuAuth from "./locales/zu/auth.json";

import yoCommon from "./locales/yo/common.json";
import yoNavigation from "./locales/yo/navigation.json";
import yoProfile from "./locales/yo/profile.json";
import yoTournaments from "./locales/yo/tournaments.json";
import yoScoring from "./locales/yo/scoring.json";
import yoRange from "./locales/yo/range.json";
import yoTeeBookings from "./locales/yo/teeBookings.json";
import yoHome from "./locales/yo/home.json";
import yoShop from "./locales/yo/shop.json";
import yoLeaderboard from "./locales/yo/leaderboard.json";
import yoMatchPlay from "./locales/yo/matchPlay.json";
import yoUpdates from "./locales/yo/updates.json";
import yoFantasy from "./locales/yo/fantasy.json";
import yoOrder from "./locales/yo/order.json";
import yoHandicapCommittee from "./locales/yo/handicapCommittee.json";
import yoNotifications from "./locales/yo/notifications.json";
import yoClubSettings from "./locales/yo/clubSettings.json";
import yoStats from "./locales/yo/stats.json";
import yoAuth from "./locales/yo/auth.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English", isRTL: false, flag: "🇬🇧" },
  { code: "hi", name: "हिंदी", isRTL: false, flag: "🇮🇳" },
  { code: "ar", name: "العربية", isRTL: true, flag: "🇸🇦" },
  { code: "es", name: "Español", isRTL: false, flag: "🇪🇸" },
  { code: "fr", name: "Français", isRTL: false, flag: "🇫🇷" },
  { code: "de", name: "Deutsch", isRTL: false, flag: "🇩🇪" },
  { code: "pt", name: "Português", isRTL: false, flag: "🇧🇷" },
  { code: "ja", name: "日本語", isRTL: false, flag: "🇯🇵" },
  { code: "ko", name: "한국어", isRTL: false, flag: "🇰🇷" },
  { code: "zh", name: "中文", isRTL: false, flag: "🇨🇳" },
  { code: "th", name: "ภาษาไทย", isRTL: false, flag: "🇹🇭" },
  { code: "ms", name: "Bahasa Melayu", isRTL: false, flag: "🇲🇾" },
  { code: "id", name: "Bahasa Indonesia", isRTL: false, flag: "🇮🇩" },
  { code: "vi", name: "Tiếng Việt", isRTL: false, flag: "🇻🇳" },
  { code: "fil", name: "Filipino", isRTL: false, flag: "🇵🇭" },
  { code: "sw", name: "Kiswahili", isRTL: false, flag: "🇰🇪" },
  { code: "af", name: "Afrikaans", isRTL: false, flag: "🇿🇦" },
  { code: "am", name: "አማርኛ", isRTL: false, flag: "🇪🇹" },
  { code: "ha", name: "Hausa", isRTL: false, flag: "🇳🇬" },
  { code: "zu", name: "isiZulu", isRTL: false, flag: "🇿🇦" },
  { code: "yo", name: "Yorùbá", isRTL: false, flag: "🇳🇬" },
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const LANGUAGE_STORAGE_KEY = "@kharagolf_language";

export async function applyLanguage(lang: string): Promise<{ needsReload: boolean }> {
  const langConfig = SUPPORTED_LANGUAGES.find((l) => l.code === lang);
  const isRTL = langConfig?.isRTL ?? false;
  const needsReload = I18nManager.isRTL !== isRTL;

  if (needsReload) {
    I18nManager.forceRTL(isRTL);
  }

  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  if (i18n.language !== lang) {
    await i18n.changeLanguage(lang);
  }

  return { needsReload };
}

// `LOCALE_MAP` and `getLocale` live in `./locale` so they can be
// imported without dragging the full i18n bootstrap (and its
// `expo-localization` dep) into lightweight callers like
// `formatRelativeTime`. Re-exported here so the existing
// `import { getLocale } from "@/i18n"` call-sites keep working.
export { LOCALE_MAP, getLocale } from "./locale";

export function getDeviceLanguage(): SupportedLanguage {
  const deviceLocales = ExpoLocalization.getLocales();
  const deviceLang = deviceLocales[0]?.languageCode ?? "en";
  const supported = SUPPORTED_LANGUAGES.map((l) => l.code as string);
  return (supported.includes(deviceLang) ? deviceLang : "en") as SupportedLanguage;
}

export async function loadSavedLanguage(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved) return saved;
    return getDeviceLanguage();
  } catch {
    return "en";
  }
}

i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: "common",
  ns: ["common", "navigation", "profile", "tournaments", "scoring", "range", "teeBookings", "home", "shop", "leaderboard", "matchPlay", "updates", "fantasy", "order", "handicapCommittee", "notifications", "clubSettings", "stats", "auth"],
  resources: {
    en: {
      common: enCommon,
      navigation: enNavigation,
      profile: enProfile,
      tournaments: enTournaments,
      scoring: enScoring,
      range: enRange,
      teeBookings: enTeeBookings,
      home: enHome,
      shop: enShop,
      leaderboard: enLeaderboard,
      matchPlay: enMatchPlay,
      updates: enUpdates,
      fantasy: enFantasy,
      order: enOrder,
      handicapCommittee: enHandicapCommittee,
      notifications: enNotifications,
      clubSettings: enClubSettings,
      stats: enStats,
      auth: enAuth,
    },
    hi: {
      common: hiCommon,
      navigation: hiNavigation,
      profile: hiProfile,
      tournaments: hiTournaments,
      scoring: hiScoring,
      range: hiRange,
      teeBookings: hiTeeBookings,
      home: hiHome,
      shop: hiShop,
      leaderboard: hiLeaderboard,
      matchPlay: hiMatchPlay,
      updates: hiUpdates,
      fantasy: hiFantasy,
      order: hiOrder,
      handicapCommittee: hiHandicapCommittee,
      notifications: hiNotifications,
      clubSettings: hiClubSettings,
      stats: hiStats,
      auth: hiAuth,
    },
    ar: {
      common: arCommon,
      navigation: arNavigation,
      profile: arProfile,
      tournaments: arTournaments,
      scoring: arScoring,
      range: arRange,
      teeBookings: arTeeBookings,
      home: arHome,
      shop: arShop,
      leaderboard: arLeaderboard,
      matchPlay: arMatchPlay,
      updates: arUpdates,
      fantasy: arFantasy,
      order: arOrder,
      handicapCommittee: arHandicapCommittee,
      notifications: arNotifications,
      clubSettings: arClubSettings,
      stats: arStats,
      auth: arAuth,
    },
    es: {
      common: esCommon,
      navigation: esNavigation,
      profile: esProfile,
      tournaments: esTournaments,
      scoring: esScoring,
      range: esRange,
      teeBookings: esTeeBookings,
      home: esHome,
      shop: esShop,
      leaderboard: esLeaderboard,
      matchPlay: esMatchPlay,
      updates: esUpdates,
      fantasy: esFantasy,
      order: esOrder,
      handicapCommittee: esHandicapCommittee,
      notifications: esNotifications,
      clubSettings: esClubSettings,
      stats: esStats,
      auth: esAuth,
    },
    fr: {
      common: frCommon,
      navigation: frNavigation,
      profile: frProfile,
      tournaments: frTournaments,
      scoring: frScoring,
      range: frRange,
      teeBookings: frTeeBookings,
      home: frHome,
      shop: frShop,
      leaderboard: frLeaderboard,
      matchPlay: frMatchPlay,
      updates: frUpdates,
      fantasy: frFantasy,
      order: frOrder,
      handicapCommittee: frHandicapCommittee,
      notifications: frNotifications,
      clubSettings: frClubSettings,
      stats: frStats,
      auth: frAuth,
    },
    de: {
      common: deCommon,
      navigation: deNavigation,
      profile: deProfile,
      tournaments: deTournaments,
      scoring: deScoring,
      range: deRange,
      teeBookings: deTeeBookings,
      home: deHome,
      shop: deShop,
      leaderboard: deLeaderboard,
      matchPlay: deMatchPlay,
      updates: deUpdates,
      fantasy: deFantasy,
      order: deOrder,
      handicapCommittee: deHandicapCommittee,
      notifications: deNotifications,
      clubSettings: deClubSettings,
      stats: deStats,
      auth: deAuth,
    },
    pt: {
      common: ptCommon,
      navigation: ptNavigation,
      profile: ptProfile,
      tournaments: ptTournaments,
      scoring: ptScoring,
      range: ptRange,
      teeBookings: ptTeeBookings,
      home: ptHome,
      shop: ptShop,
      leaderboard: ptLeaderboard,
      matchPlay: ptMatchPlay,
      updates: ptUpdates,
      fantasy: ptFantasy,
      order: ptOrder,
      handicapCommittee: ptHandicapCommittee,
      notifications: ptNotifications,
      clubSettings: ptClubSettings,
      stats: ptStats,
      auth: ptAuth,
    },
    ja: {
      common: jaCommon,
      navigation: jaNavigation,
      profile: jaProfile,
      tournaments: jaTournaments,
      scoring: jaScoring,
      range: jaRange,
      teeBookings: jaTeeBookings,
      home: jaHome,
      shop: jaShop,
      leaderboard: jaLeaderboard,
      matchPlay: jaMatchPlay,
      updates: jaUpdates,
      fantasy: jaFantasy,
      order: jaOrder,
      handicapCommittee: jaHandicapCommittee,
      notifications: jaNotifications,
      clubSettings: jaClubSettings,
      stats: jaStats,
      auth: jaAuth,
    },
    ko: {
      common: koCommon,
      navigation: koNavigation,
      profile: koProfile,
      tournaments: koTournaments,
      scoring: koScoring,
      range: koRange,
      teeBookings: koTeeBookings,
      home: koHome,
      shop: koShop,
      leaderboard: koLeaderboard,
      matchPlay: koMatchPlay,
      updates: koUpdates,
      fantasy: koFantasy,
      order: koOrder,
      handicapCommittee: koHandicapCommittee,
      notifications: koNotifications,
      clubSettings: koClubSettings,
      stats: koStats,
      auth: koAuth,
    },
    zh: {
      common: zhCommon,
      navigation: zhNavigation,
      profile: zhProfile,
      tournaments: zhTournaments,
      scoring: zhScoring,
      range: zhRange,
      teeBookings: zhTeeBookings,
      home: zhHome,
      shop: zhShop,
      leaderboard: zhLeaderboard,
      matchPlay: zhMatchPlay,
      updates: zhUpdates,
      fantasy: zhFantasy,
      order: zhOrder,
      handicapCommittee: zhHandicapCommittee,
      notifications: zhNotifications,
      clubSettings: zhClubSettings,
      stats: zhStats,
      auth: zhAuth,
    },
    th: {
      common: thCommon,
      navigation: thNavigation,
      profile: thProfile,
      tournaments: thTournaments,
      scoring: thScoring,
      range: thRange,
      teeBookings: thTeeBookings,
      home: thHome,
      shop: thShop,
      leaderboard: thLeaderboard,
      matchPlay: thMatchPlay,
      updates: thUpdates,
      fantasy: thFantasy,
      order: thOrder,
      handicapCommittee: thHandicapCommittee,
      notifications: thNotifications,
      clubSettings: thClubSettings,
      stats: thStats,
      auth: thAuth,
    },
    ms: {
      common: msCommon,
      navigation: msNavigation,
      profile: msProfile,
      tournaments: msTournaments,
      scoring: msScoring,
      range: msRange,
      teeBookings: msTeeBookings,
      home: msHome,
      shop: msShop,
      leaderboard: msLeaderboard,
      matchPlay: msMatchPlay,
      updates: msUpdates,
      fantasy: msFantasy,
      order: msOrder,
      handicapCommittee: msHandicapCommittee,
      notifications: msNotifications,
      clubSettings: msClubSettings,
      stats: msStats,
      auth: msAuth,
    },
    id: {
      common: idCommon,
      navigation: idNavigation,
      profile: idProfile,
      tournaments: idTournaments,
      scoring: idScoring,
      range: idRange,
      teeBookings: idTeeBookings,
      home: idHome,
      shop: idShop,
      leaderboard: idLeaderboard,
      matchPlay: idMatchPlay,
      updates: idUpdates,
      fantasy: idFantasy,
      order: idOrder,
      handicapCommittee: idHandicapCommittee,
      notifications: idNotifications,
      clubSettings: idClubSettings,
      stats: idStats,
      auth: idAuth,
    },
    vi: {
      common: viCommon,
      navigation: viNavigation,
      profile: viProfile,
      tournaments: viTournaments,
      scoring: viScoring,
      range: viRange,
      teeBookings: viTeeBookings,
      home: viHome,
      shop: viShop,
      leaderboard: viLeaderboard,
      matchPlay: viMatchPlay,
      updates: viUpdates,
      fantasy: viFantasy,
      order: viOrder,
      handicapCommittee: viHandicapCommittee,
      notifications: viNotifications,
      clubSettings: viClubSettings,
      stats: viStats,
      auth: viAuth,
    },
    fil: {
      common: filCommon,
      navigation: filNavigation,
      profile: filProfile,
      tournaments: filTournaments,
      scoring: filScoring,
      range: filRange,
      teeBookings: filTeeBookings,
      home: filHome,
      shop: filShop,
      leaderboard: filLeaderboard,
      matchPlay: filMatchPlay,
      updates: filUpdates,
      fantasy: filFantasy,
      order: filOrder,
      handicapCommittee: filHandicapCommittee,
      notifications: filNotifications,
      clubSettings: filClubSettings,
      stats: filStats,
      auth: filAuth,
    },
    sw: {
      common: swCommon,
      navigation: swNavigation,
      profile: swProfile,
      tournaments: swTournaments,
      scoring: swScoring,
      range: swRange,
      teeBookings: swTeeBookings,
      home: swHome,
      shop: swShop,
      leaderboard: swLeaderboard,
      matchPlay: swMatchPlay,
      updates: swUpdates,
      fantasy: swFantasy,
      order: swOrder,
      handicapCommittee: swHandicapCommittee,
      notifications: swNotifications,
      clubSettings: swClubSettings,
      stats: swStats,
      auth: swAuth,
    },
    af: {
      common: afCommon,
      navigation: afNavigation,
      profile: afProfile,
      tournaments: afTournaments,
      scoring: afScoring,
      range: afRange,
      teeBookings: afTeeBookings,
      home: afHome,
      shop: afShop,
      leaderboard: afLeaderboard,
      matchPlay: afMatchPlay,
      updates: afUpdates,
      fantasy: afFantasy,
      order: afOrder,
      handicapCommittee: afHandicapCommittee,
      notifications: afNotifications,
      clubSettings: afClubSettings,
      stats: afStats,
      auth: afAuth,
    },
    am: {
      common: amCommon,
      navigation: amNavigation,
      profile: amProfile,
      tournaments: amTournaments,
      scoring: amScoring,
      range: amRange,
      teeBookings: amTeeBookings,
      home: amHome,
      shop: amShop,
      leaderboard: amLeaderboard,
      matchPlay: amMatchPlay,
      updates: amUpdates,
      fantasy: amFantasy,
      order: amOrder,
      handicapCommittee: amHandicapCommittee,
      notifications: amNotifications,
      clubSettings: amClubSettings,
      stats: amStats,
      auth: amAuth,
    },
    ha: {
      common: haCommon,
      navigation: haNavigation,
      profile: haProfile,
      tournaments: haTournaments,
      scoring: haScoring,
      range: haRange,
      teeBookings: haTeeBookings,
      home: haHome,
      shop: haShop,
      leaderboard: haLeaderboard,
      matchPlay: haMatchPlay,
      updates: haUpdates,
      fantasy: haFantasy,
      order: haOrder,
      handicapCommittee: haHandicapCommittee,
      notifications: haNotifications,
      clubSettings: haClubSettings,
      stats: haStats,
      auth: haAuth,
    },
    zu: {
      common: zuCommon,
      navigation: zuNavigation,
      profile: zuProfile,
      tournaments: zuTournaments,
      scoring: zuScoring,
      range: zuRange,
      teeBookings: zuTeeBookings,
      home: zuHome,
      shop: zuShop,
      leaderboard: zuLeaderboard,
      matchPlay: zuMatchPlay,
      updates: zuUpdates,
      fantasy: zuFantasy,
      order: zuOrder,
      handicapCommittee: zuHandicapCommittee,
      notifications: zuNotifications,
      clubSettings: zuClubSettings,
      stats: zuStats,
      auth: zuAuth,
    },
    yo: {
      common: yoCommon,
      navigation: yoNavigation,
      profile: yoProfile,
      tournaments: yoTournaments,
      scoring: yoScoring,
      range: yoRange,
      teeBookings: yoTeeBookings,
      home: yoHome,
      shop: yoShop,
      leaderboard: yoLeaderboard,
      matchPlay: yoMatchPlay,
      updates: yoUpdates,
      fantasy: yoFantasy,
      order: yoOrder,
      handicapCommittee: yoHandicapCommittee,
      notifications: yoNotifications,
      clubSettings: yoClubSettings,
      stats: yoStats,
      auth: yoAuth,
    },
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
