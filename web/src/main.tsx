import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { desktop, getToken } from "./api";
import { Layout } from "./Layout";
import { Login } from "./pages/Login";
import { Meetings } from "./pages/Meetings";
import { Search } from "./pages/Search";
import { MeetingPage } from "./pages/MeetingPage";
import { ExtensionPage } from "./pages/ExtensionPage";
import { SettingsPage } from "./pages/SettingsPage";
import "./style.css";

function Private({ children }: { children: React.ReactNode }) {
  if (getToken()) return children;
  // No app o token vem na URL; se faltar, é só reabrir pelo app.
  if (desktop) return <p style={{ padding: 24 }}>Feche e abra o EscutaIA de novo.</p>;
  return <Navigate to="/login" replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <Private>
              <Layout />
            </Private>
          }
        >
          <Route path="/" element={<Meetings />} />
          <Route path="/search" element={<Search />} />
          <Route path="/meetings/:id" element={<MeetingPage />} />
          <Route path="/instalar" element={<ExtensionPage />} />
          <Route path="/extensao" element={<ExtensionPage />} />
          <Route path="/configuracoes" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
