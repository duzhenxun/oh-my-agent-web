import { createRoot } from "react-dom/client";
import { SidebarMenu } from "../../web/src/components/SidebarMenu.tsx";
import { loadEnTable } from "../../web/src/use-language.ts";
import { LANGUAGE_KEY } from "../../web/src/language.ts";
import "../../web/src/styles.css";

localStorage.setItem(LANGUAGE_KEY, new URLSearchParams(location.search).get("lang") === "zh" ? "zh" : "en");
document.documentElement.classList.toggle("is-mobile-shell", innerWidth <= 640);
await loadEnTable();
createRoot(document.getElementById("root")!).render(<SidebarMenu initialPanel="bug" />);
