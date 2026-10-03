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
  KeyApiError,
} from "./api";
import { freshPhrase } from "./freshPhrase";

interface AuthState {
  token: string | null; // admin token (ms_admin_…)
  employeeKey: string | null; // employee MoneyKey (mk_live_…)
  loading: boolean;
  /** Error CODE (not display text): "admin_invalid" | "unreachable" | a MoneyKey error code (KEY_REVOKED…) | "generic". LoginPage localizes it. */
  error: string | null;
  errorDetail: string | null;
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
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const loginAdmin = useCallback(async (candidate: string) => {
    setLoading(true);
    setError(null);
    setErrorDetail(null);
    try {
      const ok = await verifyAdminToken(candidate);
      if (!ok) {
        setError("admin_invalid");
        setLoading(false);
        return false;
      }
      persistToken(candidate);
      setTokenState(candidate);
      setLoading(false);
      return true;
    } catch {
      setError("unreachable");
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
    setErrorDetail(null);
    try {
      await getStatus(candidate);
      persistEmployeeKey(candidate);
      setEmployeeKeyState(candidate);
      setLoading(false);
      return true;
    } catch (e) {
      if (e instanceof KeyApiError) {
        const code = e.code ?? (e.status === 401 ? "KEY_INVALID" : "generic");
        // v0.4: a sub-key whose parent/ancestor was revoked or expired.
        setError(e.limitScope === "ancestor" && (code === "KEY_REVOKED" || code === "KEY_EXPIRED") ? `${code}_ANCESTOR` : code);
        setErrorDetail(e.message);
      } else {
        setError("unreachable");
      }
      setLoading(false);
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    freshPhrase.clear(); // a just-created wallet's recovery phrase must not outlive the session
    clearToken();
    clearEmployeeKey();
    setTokenState(null);
    setEmployeeKeyState(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, employeeKey, loading, error, errorDetail, loginAdmin, loginEmployee, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
