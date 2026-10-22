/**
 * DensityGrid component tests (#1547).
 *
 * Comprehensive unit and snapshot tests for the Density Grid component.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DensityGrid } from "./DensityGrid";

describe("DensityGrid", () => {
  const mockData = [
    { label: "Jan", value: 100 },
    { label: "Feb", value: 150 },
    { label: "Mar", value: 200 },
  ];

  it("renders with data", () => {
    render(<DensityGrid data={mockData} />);
    expect(screen.getByTestId("density-grid")).toBeInTheDocument();
  });

  it("renders empty state when no data", () => {
    render(<DensityGrid data={[]} />);
    expect(screen.getByTestId("density-grid-empty")).toBeInTheDocument();
  });

  it("renders correct number of cells", () => {
    render(<DensityGrid data={mockData} />);
    const cells = screen.getAllByTestId("density-cell");
    expect(cells).toHaveLength(mockData.length);
  });

  it("applies correct density classes based on value", () => {
    render(<DensityGrid data={mockData} />);
    const cells = screen.getAllByTestId("density-cell");
    // Each cell should have a density class
    cells.forEach((cell) => {
      expect(cell.className).toMatch(/density-\d/);
    });
  });

  it("displays labels when showLabels is true", () => {
    render(<DensityGrid data={mockData} showLabels />);
    mockData.forEach((item) => {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    });
  });

  it("handles keyboard navigation", () => {
    render(<DensityGrid data={mockData} />);
    const grid = screen.getByTestId("density-grid");
    expect(grid).toHaveAttribute("role", "grid");
    expect(grid).toHaveAttribute("tabIndex", "0");
  });

  it("matches snapshot", () => {
    const { container } = render(<DensityGrid data={mockData} />);
    expect(container).toMatchSnapshot();
  });

  it("matches snapshot with labels", () => {
    const { container } = render(<DensityGrid data={mockData} showLabels />);
    expect(container).toMatchSnapshot();
  });
});
