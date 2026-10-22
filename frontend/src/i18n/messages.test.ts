import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import fr from "../../messages/fr.json";
import {
  defaultLocale,
  isValidLocale,
  localeToLanguageTag,
  locales,
  resolveAppLocale,
} from "@/i18n/config";

type Messages = { [key: string]: string | Messages };

const catalogues: Record<string, Messages> = { en, es, pt, fr };

function flatten(messages: Messages, prefix = ""): Record<string, string> {
  return Object.entries(messages).reduce<Record<string, string>>((acc, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      acc[path] = value;
    } else {
      Object.assign(acc, flatten(value, path));
    }
    return acc;
  }, {});
}

/** Top-level ICU argument names, e.g. "{count, plural, one {# x}}" -> ["count"]. */
function icuArguments(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i += 1) {
    const char = message[i];
    if (char === "{") {
      if (depth === 0) {
        const match = /^\{\s*(\w+)\s*[,}]/.exec(message.slice(i));
        if (match) names.add(match[1]);
      }
      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return [...names].sort();
}

const english = flatten(en as Messages);

describe("Dashboard i18n catalogues (#428)", () => {
  it("ships a message catalogue for every configured locale", () => {
    expect([...locales].sort()).toEqual(["en", "es", "fr", "pt"]);
    for (const locale of locales) {
      expect(catalogues[locale], `missing messages/${locale}.json`).toBeDefined();
    }
  });

  it.each(["es", "pt", "fr"])("%s has exactly the same keys as en", (locale) => {
    const translated = flatten(catalogues[locale]);
    const missing = Object.keys(english).filter((key) => !(key in translated));
    const extra = Object.keys(translated).filter((key) => !(key in english));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it.each(["es", "pt", "fr"])("%s keeps every ICU placeholder used by en", (locale) => {
    const translated = flatten(catalogues[locale]);
    const mismatches = Object.keys(english).filter(
      (key) => icuArguments(english[key]).join() !== icuArguments(translated[key] ?? "").join(),
    );
    expect(mismatches).toEqual([]);
  });

  it.each(["es", "pt", "fr"])("%s has no empty translations", (locale) => {
    const empty = Object.entries(flatten(catalogues[locale]))
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it("labels every locale in the header switcher in every catalogue", () => {
    for (const catalogue of Object.values(catalogues)) {
      const options = (catalogue.localeSwitcher as Messages).options as Messages;
      expect(Object.keys(options).sort()).toEqual([...locales].sort());
    }
  });

  it("translates the dashboard shell navigation label", () => {
    expect(flatten(fr as Messages)["dashboardShell.openNavigationMenu"]).toBe(
      "Ouvrir le menu de navigation",
    );
  });
});

describe("i18n config", () => {
  it("accepts fr as a valid locale and maps it to fr-FR", () => {
    expect(isValidLocale("fr")).toBe(true);
    expect(resolveAppLocale("fr")).toBe("fr");
    expect(localeToLanguageTag("fr")).toBe("fr-FR");
  });

  it("falls back to the default locale for unknown or empty values", () => {
    expect(isValidLocale("de")).toBe(false);
    expect(resolveAppLocale("de")).toBe(defaultLocale);
    expect(resolveAppLocale(undefined)).toBe(defaultLocale);
    expect(localeToLanguageTag("xx")).toBe("en-US");
  });
});
