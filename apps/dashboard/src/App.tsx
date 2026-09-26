import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { LangProvider } from "./i18n";
import SetupPage from "./pages/SetupPage";
import "./styles/shell.css";
import Layout from "./Layout";
import EmployeeLayout from "./EmployeeLayout";
import LoginPage from "./pages/LoginPage";
import OverviewPage from "./pages/OverviewPage";
import MoneyKeysPage from "./pages/MoneyKeysPage";
import UsagePage from "./pages/UsagePage";
import ApprovalsPage from "./pages/ApprovalsPage";
import WalletPage from "./pages/WalletPage";
import ConnectAgentPage from "./pages/ConnectAgentPage";
import ChannelsPage from "./pages/ChannelsPage";
import PlaygroundPage from "./pages/PlaygroundPage";
import TollboothsPage from "./pages/TollboothsPage";
import TollboothWizardPage from "./pages/TollboothWizardPage";
import TollboothDetailPage from "./pages/TollboothDetailPage";
import EarningsPage from "./pages/EarningsPage";
import MyBudgetPage from "./pages/employee/MyBudgetPage";
import EmployeePlaygroundPage from "./pages/employee/EmployeePlaygroundPage";
import EmployeeHistoryPage from "./pages/employee/EmployeeHistoryPage";
import EmployeeConnectPage from "./pages/employee/EmployeeConnectPage";
import MySubKeysPage from "./pages/employee/MySubKeysPage";

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return children;
}

function RequireEmployee({ children }: { children: React.ReactElement }) {
  const { employeeKey } = useAuth();
  if (!employeeKey) return <Navigate to="/login" replace />;
  return children;
}

function Routed() {
  const { token, employeeKey } = useAuth();
  const loggedInPath = token ? "/" : employeeKey ? "/me" : null;

  return (
    <Routes>
      {/* First-run wizard (docs/ux-audit.md A-1/A-2). Not behind RequireAdmin: it
          handles the one-time /setup#ms_setup_… claim itself, and redirects
          to /login when there is neither a setup token nor an admin session. */}
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={loggedInPath ? <Navigate to={loggedInPath} replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAdmin>
            <Layout />
          </RequireAdmin>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="keys" element={<MoneyKeysPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="connect" element={<ConnectAgentPage />} />
        <Route path="tollbooths" element={<TollboothsPage />} />
        <Route path="tollbooths/new" element={<TollboothWizardPage />} />
        <Route path="tollbooths/:id" element={<TollboothDetailPage />} />
        <Route path="earnings" element={<EarningsPage />} />
      </Route>

      {/* SPEC-v0.3-employee.md §A — employee view, separate route tree, own
          layout, gated by the mk_live_ key instead of the admin token. */}
      <Route
        path="/me"
        element={
          <RequireEmployee>
            <EmployeeLayout />
          </RequireEmployee>
        }
      >
        <Route index element={<Navigate to="budget" replace />} />
        <Route path="budget" element={<MyBudgetPage />} />
        <Route path="playground" element={<EmployeePlaygroundPage />} />
        <Route path="history" element={<EmployeeHistoryPage />} />
        <Route path="connect" element={<EmployeeConnectPage />} />
        {/* SPEC-v0.4.md §A: employee's own sub-keys, shown when their key can_delegate. */}
        <Route path="children" element={<MySubKeysPage />} />
      </Route>

      <Route path="*" element={<Navigate to={loggedInPath ?? "/login"} replace />} />
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
