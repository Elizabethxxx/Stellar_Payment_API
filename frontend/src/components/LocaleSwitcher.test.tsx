import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";

const replace = vi.fn();
let mockLocale = "en";

vi.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: (namespace: string) => (key: string) => {
    const scope = (en as Record<string, unknown>)[namespace] as Record<string, unknown>;
    return key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], scope) as string;
  },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=all"),
}));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ replace }),
}));

import LocaleSwitcher from "./LocaleSwitcher";

describe("LocaleSwitcher (#428)", () => {
  beforeEach(() => {
    replace.mockClear();
    mockLocale = "en";
    document.cookie = "NEXT_LOCALE=; path=/; max-age=0";
  });

  it("offers English, Spanish, Portuguese and French", () => {
    render(<LocaleSwitcher />);
    const options = screen.getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(options).toEqual(["en", "es", "pt", "fr"]);
    expect(screen.getByRole("option", { name: "Francais" })).toBeInTheDocument();
  });

  it("persists the chosen locale and re-renders the current dashboard route", () => {
    render(<LocaleSwitcher />);
    fireEvent.change(screen.getByLabelText("Select language"), { target: { value: "fr" } });

    expect(document.cookie).toContain("NEXT_LOCALE=fr");
    expect(replace).toHaveBeenCalledWith("/dashboard?tab=all", { locale: "fr", scroll: false });
  });

  it("does nothing when the active locale is selected again", () => {
    mockLocale = "fr";
    render(<LocaleSwitcher />);
    fireEvent.change(screen.getByLabelText("Select language"), { target: { value: "fr" } });
    expect(replace).not.toHaveBeenCalled();
  });

  it("falls back to English when the active locale is unsupported", () => {
    mockLocale = "de";
    render(<LocaleSwitcher />);
    expect((screen.getByLabelText("Select language") as HTMLSelectElement).value).toBe("en");
  });
});
