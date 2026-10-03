import React, { createContext, useContext, useState, useCallback } from "react";
import { getToken, setToken as persistToken, clearToken, verifyAdminToken } from "./api";
import { freshPhrase } from "./freshPhrase";

interface AuthState {
  token: string | null; // the administrator token (ms_admin_…): the only login the dashboard has
  loading: boolean;
  /** Error CODE (not display text): "admin_invalid" | "unreachable". LoginPage localizes it. */
  error: string | null;
  loginAdmin: (token: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loginAdmin = useCallback(async (candidate: string) => {
    setLoading(true);
    setError(null);
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

  const logout = useCallback(() => {
    freshPhrase.clear(); // a just-created wallet's recovery phrase must not outlive the session
    clearToken();
    setTokenState(null);
  }, []);

  return <AuthContext.Provider value={{ token, loading, error, loginAdmin, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
