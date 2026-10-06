import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FidelityGate } from "./fidelity/FidelityGate";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.hash === "#fidelity-gate" ? <FidelityGate /> : <App />}
  </StrictMode>,
);
