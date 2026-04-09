"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Props {
  data: { timestamp: number; valueUsd: number }[];
}

export function PnlChart({ data }: Props) {
  const first = data[0]?.valueUsd ?? 0;
  const last = data[data.length - 1]?.valueUsd ?? 0;
  const isPositive = last >= first;
  const color = isPositive ? "var(--green)" : "var(--red)";
  const gradientId = isPositive ? "pnlGreen" : "pnlRed";

  return (
    <ResponsiveContainer width="100%" height={80}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="pnlGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#00e5a0" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#00e5a0" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="pnlRed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ff4060" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#ff4060" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="timestamp" hide />
        <YAxis domain={["auto", "auto"]} hide />
        <Tooltip
          contentStyle={{
            background: "var(--surface2)",
            border: "1px solid var(--border2)",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text)",
          }}
          formatter={(value: number) => [
            "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            "Value",
          ]}
          labelFormatter={() => ""}
        />
        <Area
          type="monotone"
          dataKey="valueUsd"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 3, fill: color, strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
