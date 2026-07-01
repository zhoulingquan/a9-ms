import { Menu, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { inferProviderFromModelName, providerBrand } from "@/lib/provider-brand";
import { cn } from "@/lib/utils";

interface ThreadHeaderProps {
  title: string;
  onToggleSidebar: () => void;
  theme: "light" | "dark" | "system";
  onToggleTheme: () => void;
  onToggleLanguage: () => void;
  hideSidebarToggleForHostChrome?: boolean;
  minimal?: boolean;
  modelLabel?: string | null;
  modelProvider?: string | null;
}

export function ThreadHeader({
  title,
  onToggleSidebar,
  theme,
  onToggleTheme,
  onToggleLanguage,
  hideSidebarToggleForHostChrome = false,
  minimal = false,
  modelLabel = null,
  modelProvider = null,
}: ThreadHeaderProps) {
  const { t } = useTranslation();
  if (minimal) {
    return (
      <div className="relative z-10 flex h-11 items-center justify-between gap-3 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("thread.header.toggleSidebar")}
          onClick={onToggleSidebar}
          className={cn(
            "h-7 w-7 rounded-md text-muted-foreground hover:bg-accent/35 hover:text-foreground",
            hideSidebarToggleForHostChrome && "lg:hidden",
          )}
        >
          <Menu className="h-3.5 w-3.5" />
        </Button>
        <div className="ml-auto flex items-center -space-x-1">
          <LocaleButton
            onToggleLanguage={onToggleLanguage}
            label={t("thread.header.toggleLanguage")}
          />
          <ThemeButton
            theme={theme}
            onToggleTheme={onToggleTheme}
            label={t("thread.header.toggleTheme")}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-10 flex items-center justify-between gap-3 px-3 py-2">
      <div className="relative flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("thread.header.toggleSidebar")}
          onClick={onToggleSidebar}
          className={cn(
            "h-7 w-7 rounded-md text-muted-foreground hover:bg-accent/35 hover:text-foreground",
            hideSidebarToggleForHostChrome && "lg:hidden",
          )}
        >
          <Menu className="h-3.5 w-3.5" />
        </Button>
        <div className="flex min-w-0 items-center rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground">
          <span className="max-w-[min(60vw,32rem)] truncate">{title}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {modelLabel ? (
          <HeaderModelBadge label={modelLabel} provider={modelProvider} />
        ) : null}
        <div className="flex items-center -space-x-1">
          <LocaleButton
            onToggleLanguage={onToggleLanguage}
            label={t("thread.header.toggleLanguage")}
          />
          <ThemeButton
            theme={theme}
            onToggleTheme={onToggleTheme}
            label={t("thread.header.toggleTheme")}
          />
        </div>
      </div>

      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-4" />
    </div>
  );
}

function HeaderModelBadge({
  label,
  provider,
}: {
  label: string;
  provider?: string | null;
}) {
  const inferredProvider = provider || inferProviderFromModelName(label);
  const brand = providerBrand(inferredProvider);

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/45 bg-card/80 px-2.5 py-1",
        "text-[11.5px] font-medium text-foreground/75 shadow-[0_1px_3px_rgba(15,23,42,0.04)]",
      )}
    >
      <span
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center overflow-hidden rounded-full border bg-background",
        )}
        style={{
          borderColor: brand ? `${brand.color}28` : undefined,
        }}
        aria-hidden
      >
        {brand ? (
          brand.logoUrls[0] ? (
            <img
              src={brand.logoUrls[0]}
              alt=""
              className="h-2.5 w-2.5 object-contain"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <span
              className="grid h-full w-full place-items-center rounded-full text-white text-[6px]"
              style={{ backgroundColor: brand.color }}
            >
              {brand.initials.slice(0, 2)}
            </span>
          )
        ) : null}
      </span>
      <span className="truncate max-w-[10rem]">{label}</span>
    </span>
  );
}

function ThemeButton({
  theme,
  onToggleTheme,
  label,
  className,
}: {
  theme: "light" | "dark" | "system";
  onToggleTheme: () => void;
  label: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onToggleTheme}
      className={cn(
        "h-8 w-8 rounded-full text-muted-foreground/85 hover:bg-accent/40 hover:text-foreground",
        className,
      )}
    >
      {theme === "light" ? (
        <Sun className="h-4 w-4" />
      ) : theme === "dark" ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Monitor className="h-4 w-4" />
      )}
    </Button>
  );
}

function LocaleButton({
  onToggleLanguage,
  label,
  className,
}: {
  onToggleLanguage: () => void;
  label: string;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const isEn = (i18n.resolvedLanguage ?? i18n.language) === "en";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onToggleLanguage}
      className={cn(
        "h-8 w-8 rounded-full hover:bg-accent/40 hover:text-foreground",
        className,
      )}
    >
      <span className="flex items-baseline gap-[1px] text-[10px] leading-none tracking-tight">
        <span className={cn(
          "font-semibold text-foreground",
          !isEn && "font-normal text-muted-foreground/45",
        )}>A</span>
        <span className={cn(
          "font-semibold text-foreground",
          isEn && "font-normal text-muted-foreground/45",
        )}>文</span>
      </span>
    </Button>
  );
}
