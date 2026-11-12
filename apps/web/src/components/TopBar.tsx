import { useEffect, useState } from "react";
import { LOCALES, type Locale } from "../lib/i18n";
import Select from "./Select";
import { switchLocale } from "../lib/locale-path";

function readIsDark() {
  if (typeof document === "undefined") return true;
  return document.documentElement.dataset.theme !== "light";
}

/** Top-bar language select + live theme toggle (no full page reload). */
export default function TopBar() {
  const lang = (document.documentElement.lang as Locale) in LOCALES ? (document.documentElement.lang as Locale) : "en";
  const [dark, setDark] = useState<boolean>(readIsDark);

  useEffect(() => {
    const sync = () => setDark(readIsDark());
    window.addEventListener("mtcx-theme", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("mtcx-theme", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    const win = window as Window & { __setTheme?: (t: string) => void };
    if (win.__setTheme) {
      win.__setTheme(next);
    } else {
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
      try {
        localStorage.setItem("ou_theme", next);
        localStorage.setItem("mtcx-theme", next);
      } catch {}
    }
    setDark(next === "dark");
  };

  const icon = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <>
      <Select
        compact
        label="Language"
        value={lang}
        options={(Object.keys(LOCALES) as Locale[]).map((k) => ({ value: k, label: LOCALES[k] }))}
        onChange={(l) => switchLocale(l)}
        icon={<svg {...icon}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" /></svg>}
      />
      <button
        type="button"
        className="icon-btn"
        aria-label="Toggle theme"
        aria-pressed={!dark}
        onClick={toggleTheme}
      >
        {dark
          ? <svg {...icon}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          : <svg {...icon}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></svg>}
      </button>
    </>
  );
}
