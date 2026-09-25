// Node-global polyfills (`Buffer`, `process.env`) for dependencies that use them at module top
// level. Must be the FIRST import: ES module imports evaluate before this file's body, so an inline
// assignment here would run after those dependencies already threw (see ./polyfills.ts).
import "./polyfills.js";

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/app.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
