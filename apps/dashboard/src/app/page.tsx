import { Providers } from "./providers";
import { Dashboard } from "@/components/Dashboard";

export default function Home() {
  return (
    <Providers>
      <Dashboard />
    </Providers>
  );
}
