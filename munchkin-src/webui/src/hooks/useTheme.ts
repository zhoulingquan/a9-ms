import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "munchkin-webui.theme";
const ThemeContext = createContext<"light" | "dark">("light");

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : null;
  } catch {
    return null;
  }
}

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  }
  return theme;
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (resolveTheme(theme) === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export function useTheme(): {
  theme: Theme;
  resolved: "light" | "dark";
  toggle: () => void;
  setTheme: (t: Theme) => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStored();
    if (stored) return stored;
    return "system";
  });
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveTheme(theme));

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore
    }
    if (theme !== "system") {
      setResolved(theme);
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      applyTheme("system");
      setResolved(resolveTheme("system"));
    };
    setResolved(resolveTheme("system"));
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(
    () => setThemeState((t) => (t === "light" ? "dark" : t === "dark" ? "system" : "light")),
    [],
  );
  return { theme, resolved, toggle, setTheme };
}

export function ThemeProvider({ theme, children }: { theme: "light" | "dark"; children: ReactNode }) {
  return createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useThemeValue(): "light" | "dark" {
  return useContext(ThemeContext);
}
