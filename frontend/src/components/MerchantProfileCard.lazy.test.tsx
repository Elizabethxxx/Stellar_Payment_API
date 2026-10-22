import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Mock next/dynamic to test the loading skeleton
vi.mock("next/dynamic", () => ({
  default: vi.fn((_loader: any, options?: { loading?: () => React.ReactNode }) => {
    return function DynamicStub() {
      return options?.loading ? options.loading() : null;
    };
  }),
}));

import MerchantProfileCardLazy, {
  MerchantProfileCardSkeleton,
} from "./MerchantProfileCard.lazy";

describe("MerchantProfileCard.lazy", () => {
  it("exports a dynamic component", () => {
    expect(MerchantProfileCardLazy).toBeDefined();
  });

  it("renders the loading skeleton while component is dynamically imported", () => {
    render(<MerchantProfileCardLazy />);
    const skeleton = screen.getByTestId("merchant-profile-card-skeleton");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveAttribute("role", "status");
    expect(skeleton).toHaveAttribute("aria-label", "Loading profile…");
  });

  it("renders MerchantProfileCardSkeleton standalone", () => {
    render(<MerchantProfileCardSkeleton />);
    const skeleton = screen.getByTestId("merchant-profile-card-skeleton");
    expect(skeleton).toBeInTheDocument();
  });
});
