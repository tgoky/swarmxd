/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  // Transpile workspace packages
  transpilePackages: ["@swarm/shared"],
};

module.exports = config;