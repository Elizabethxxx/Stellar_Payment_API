import { render, screen, fireEvent } from "@testing-library/react";
import { useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import LocaleSwitcher from "../LocaleSwitcher";

// Mock next-intl
jest.mock("next-intl", () => ({
  useLocale: jest.fn(),
  useTranslations: jest.fn(),
}));

// Mock next/navigation
jest.mock("next/navigation", () => ({
  useSearchParams: jest.fn(),
}));

// Mock i18n navigation
jest.mock("@/i18n/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useRouter: jest.fn(() => ({
    replace: jest.fn(),
  })),
}));

// Mock i18n config
jest.mock("@/i18n/config", () => ({
  localeCookieMaxAge: 31536000,
  localeCookieName: "NEXT_LOCALE",
  locales: ["en", "es", "fr"],
  resolveAppLocale: (locale: string) => locale,
}));

describe("LocaleSwitcher", () => {
  const mockReplace = jest.fn();
  const mockStartTransition = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useLocale as jest.Mock).mockReturnValue("en");
    (useTranslations as jest.Mock).mockReturnValue((key: string) => key);
    (useSearchParams as jest.Mock).mockReturnValue(new URLSearchParams());
    (useTransition as jest.Mock).mockReturnValue([false, mockStartTransition]);
    const { useRouter } = jest.requireMock("@/i18n/navigation");
    useRouter.mockReturnValue({ replace: mockReplace });
  });

  it("renders locale options", () => {
    render(<LocaleSwitcher />);

    expect(screen.getByText("label")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("displays current locale as selected", () => {
    render(<LocaleSwitcher />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("en");
  });

  it("calls handleChange when locale is changed", () => {
    render(<LocaleSwitcher />);

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "es" } });

    expect(mockStartTransition).toHaveBeenCalled();
  });

  it("is disabled when pending", () => {
    (useTransition as jest.Mock).mockReturnValue([true, mockStartTransition]);

    render(<LocaleSwitcher />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("has proper aria-label", () => {
    render(<LocaleSwitcher />);

    const select = screen.getByRole("combobox");
    expect(select).toHaveAttribute("aria-label", "ariaLabel");
  });
});
