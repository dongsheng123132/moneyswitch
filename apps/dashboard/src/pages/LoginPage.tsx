import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function LoginPage() {
  const { loginAdmin, loginEmployee, loading, error } = useAuth();
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const candidate = token.trim();
    if (!candidate) return;
    setLocalError(null);

    if (candidate.startsWith("ms_admin_")) {
      const ok = await loginAdmin(candidate);
      if (ok) navigate("/", { replace: true });
      return;
    }
    if (candidate.startsWith("mk_live_")) {
      const ok = await loginEmployee(candidate);
      if (ok) navigate("/me", { replace: true });
      return;
    }
    setLocalError("这不是有效的 MoneySwitch 凭据：管理员请粘贴 ms_admin_ 开头的 token，员工请粘贴 mk_live_ 开头的 Key。");
  }

  return (
    <div className="login-shell">
      <div className="card login-card">
        <div className="login-brand">
          <div className="brand-mark">M</div>
          <div>
            <h1>MoneySwitch</h1>
          </div>
        </div>
        <p className="login-tagline">Give your AI an API key for money.</p>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="login-token">管理员 token 或员工 Key</label>
            <input
              id="login-token"
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ms_admin_… 或 mk_live_…"
            />
            <div className="field-hint">
              ms_admin_ 开头 → 打开管理员控制台（钱包/渠道/审批/全公司用量）；mk_live_ 开头 → 打开员工视图（只看自己的额度和流水）。
            </div>
          </div>
          {(localError || error) && <div className="error-banner">{localError || error}</div>}
          <button className="btn big" type="submit" disabled={loading || !token.trim()}>
            {loading ? "登录中…" : "登录"}
          </button>
        </form>
        <div className="login-footnote">USDC · Monad · x402</div>
      </div>
    </div>
  );
}
