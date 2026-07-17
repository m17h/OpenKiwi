import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hydrateNativeStorage } from "./lib/storage";
import "./styles.css";

void hydrateNativeStorage().finally(async () => {
  const { default: App } = await import("./App");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
