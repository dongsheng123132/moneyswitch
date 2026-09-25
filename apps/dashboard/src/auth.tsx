import React, { createContext, useContext, useState, useCallback } from "react";
import {
  getToken,
  setToken as persistToken,
  clearToken,
  verifyAdminToken,
  getEmployeeKey,
  setEmployeeKey as persistEmployeeKey,
  clearEmployeeKey,
  getStatus,
} from "./api";

interface AuthState {
  token: string | null; // admin token (ms_admin_…)
  employeeKey: string | null; // employee MoneyKey (mk_live_…)
  loading: boolean;
  error: string | null;
  loginAdmin: (token: string) => Promise<boolean>;
  loginEmployee: (key: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [employeeKey, setEmployeeKeyState] = useState<string | null>(() => getEmployeeKey());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginAdmin = useCallback(async (candidate: string) => {
    setLoading(true);
    setError(null);
    try {
      const ok = await verifyAdminToken(candidate);
      if (!ok) {
        setError("Token invalid or does not have admin access.");
        setLoading(false);
        return false;
      }
      persistToken(candidate);
      setTokenState(candidate);
      setLoading(false);
      return true;
    } catch {
      setError("Could not reach MoneySwitch server.");
      setLoading(false);
      return false;
    }
  }, []);

  // SPEC-v0.3-employee.md §A.1: mk_live_ keys log in to the employee view.
  // GET /v1/status doubles as the auth probe (cheap, side-effect-free, and
  // is the first thing the employee view needs anyway).
  const loginEmployee = useCallback(async (candidate: string) => {
    setLoading(true);
    setError(null);
    try {
      await getStatus(candidate);
      persistEmployeeKey(candidate);
      setEmployeeKeyState(candidate);
      setLoading(false);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Key invalid or could not reach MoneySwitch server.");
      setLoading(false);
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearToken();
    clearEmployeeKey();
    setTokenState(null);
    setEmployeeKeyState(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, employeeKey, loading, error, loginAdmin, loginEmployee, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
