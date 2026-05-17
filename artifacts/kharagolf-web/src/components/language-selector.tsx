import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";

interface LanguageSelectorProps {
  value?: string;
  onChange?: (lang: SupportedLanguage) => void;
  showLabel?: boolean;
  className?: string;
}

export function LanguageSelector({
  value,
  onChange,
  showLabel = true,
  className,
}: LanguageSelectorProps) {
  const { i18n, t } = useTranslation("common");
  const currentLang = value ?? i18n.language;
  const currentConfig = SUPPORTED_LANGUAGES.find((l) => l.code === currentLang);

  function handleChange(lang: string) {
    i18n.changeLanguage(lang);
    onChange?.(lang as SupportedLanguage);
  }

  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      {showLabel && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" />
          <span>{t("language")}</span>
        </div>
      )}
      <Select value={currentLang} onValueChange={handleChange}>
        <SelectTrigger className="w-[185px]">
          <SelectValue>
            {currentConfig && (
              <span className="flex items-center gap-2">
                <span className="text-base leading-none">{currentConfig.flag}</span>
                <span>{currentConfig.name}</span>
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              <span className="flex items-center gap-2">
                <span className="text-base leading-none">{lang.flag}</span>
                <span>{lang.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
