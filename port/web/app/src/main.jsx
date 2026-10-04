import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { startCrashWatch } from "./crash.js";
import { startKeyGuard } from "./keys.js";
import "./styles.css";

/* (before the game: its errors, and what became of the visit before) */
startCrashWatch();
startKeyGuard();

createRoot(document.getElementById("root")).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
