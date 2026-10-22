/**
 * DensityGrid component (#1547).
 *
 * Displays data as a grid of density-indicating cells with optional labels.
 */

import React from "react";

interface DensityItem {
  label: string;
  value: number;
}

interface DensityGridProps {
  data: DensityItem[];
  showLabels?: boolean;
  className?: string;
}

export function DensityGrid({ data, showLabels = false, className = "" }: DensityGridProps) {
  if (data.length === 0) {
    return (
      <div data-testid="density-grid-empty" className={`text-center py-8 text-gray-500 ${className}`}>
        No data available
      </div>
    );
  }

  const maxValue = Math.max(...data.map((d) => d.value));

  return (
    <div
      data-testid="density-grid"
      role="grid"
      tabIndex={0}
      className={`grid grid-cols-4 gap-2 p-4 ${className}`}
    >
      {data.map((item, index) => {
        const density = maxValue > 0 ? Math.round((item.value / maxValue) * 4) : 0;
        return (
          <div
            key={index}
            data-testid="density-cell"
            role="gridcell"
            aria-label={`${item.label}: ${item.value}`}
            className={`density-${density} p-3 rounded text-center text-sm transition-colors cursor-default`}
          >
            {showLabels && <div className="font-medium">{item.label}</div>}
            <div className="text-xs text-gray-600">{item.value}</div>
          </div>
        );
      })}
    </div>
  );
}

export default DensityGrid;
