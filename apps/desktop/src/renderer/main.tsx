import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

// Dark only for now; the design tokens carry the dark theme under `.dark`.
document.documentElement.classList.add("dark");

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
