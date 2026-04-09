import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages
  transpilePackages: ["@swarm/shared"],
};

export default config;
