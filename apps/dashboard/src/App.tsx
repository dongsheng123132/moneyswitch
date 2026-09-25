import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
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
import MyBudgetPage from "./pages/employee/MyBudgetPage";
import EmployeePlaygroundPage from "./pages/employee/EmployeePlaygroundPage";
import EmployeeHistoryPage from "./pages/employee/EmployeeHistoryPage";
import EmployeeConnectPage from "./pages/employee/EmployeeConnectPage";

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
      </Route>

      <Route path="*" element={<Navigate to={loggedInPath ?? "/login"} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routed />
    </AuthProvider>
  );
}
