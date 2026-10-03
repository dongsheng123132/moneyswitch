import React from "react";
import { Routes, Route, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { LangProvider } from "./i18n";
import { LANDING_PATH, loginUrlFor, safeNextPath } from "./authRedirect";
import "./styles/shell.css";
import Layout from "./Layout";
import LoginPage from "./pages/LoginPage";
import MoneyKeysPage from "./pages/MoneyKeysPage";
import BillsPage from "./pages/BillsPage";
import ApprovalsPage from "./pages/ApprovalsPage";
import WalletPage from "./pages/WalletPage";

/** Without the administrator's session every page asks for the login first and comes back to where it was (an approval link carries no token). */
function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to={loginUrlFor(location.pathname, location.search)} replace />;
  return children;
}

/** Already signed in: /login goes straight on to where the visit was heading. */
function LoginRoute() {
  const { token } = useAuth();
  const [search] = useSearchParams();
  if (token) return <Navigate to={safeNextPath(search.get("next")) ?? LANDING_PATH} replace />;
  return <LoginPage />;
}

function Routed() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route
        path="/"
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route index element={<Navigate to={LANDING_PATH} replace />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="keys" element={<MoneyKeysPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="bills" element={<BillsPage />} />
      </Route>
      <Route path="*" element={<Navigate to={LANDING_PATH} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <LangProvider>
      <AuthProvider>
        <Routed />
      </AuthProvider>
    </LangProvider>
  );
}
