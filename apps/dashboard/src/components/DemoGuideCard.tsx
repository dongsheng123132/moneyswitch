import React from "react";
import { Link } from "react-router-dom";
import { MessageSquare, ShieldAlert, HandCoins } from "lucide-react";
import { useT } from "../i18n";
import { demoStrings } from "../i18n/strings/demo";
import { useAdminMeta } from "../useAdminMeta";

/** Overview guide card shown only on the offline demo: three things to try. */
export default function DemoGuideCard() {
  const t = useT(demoStrings);
  const meta = useAdminMeta();
  const seller = meta?.demo_seller_url ?? null;
  const blockedHref = seller
    ? `/playground?mode=fetch&method=GET&url=${encodeURIComponent(`${seller.replace(/\/+$/, "")}/greedy`)}`
    : "/playground?mode=fetch";
  const items = [
    { icon: MessageSquare, title: t("guideChatTitle"), body: t("guideChatBody"), cta: t("guideChatCta"), to: "/playground", testId: "demo-guide-chat" },
    { icon: ShieldAlert, title: t("guideBlockTitle"), body: t("guideBlockBody"), cta: t("guideBlockCta"), to: blockedHref, testId: "demo-guide-block" },
    { icon: HandCoins, title: t("guideEarnTitle"), body: t("guideEarnBody"), cta: t("guideEarnCta"), to: "/earnings", testId: "demo-guide-earn" },
  ];
  return (
    <div className="card demo-guide-card" data-testid="demo-guide">
      <div className="card-header">
        <div>
          <h3>{t("guideTitle")}</h3>
          <div className="card-sub">{t("guideSub")}</div>
        </div>
      </div>
      <div className="demo-guide-grid">
        {items.map((it, i) => {
          const Icon = it.icon;
          return (
            <div className="demo-guide-item" key={it.testId}>
              <h4>
                <span className="demo-guide-step">{i + 1}</span>
                <Icon size={15} aria-hidden /> {it.title}
              </h4>
              <p>{it.body}</p>
              <Link className="btn small" to={it.to} data-testid={it.testId}>
                {it.cta}
              </Link>
            </div>
          );
        })}
      </div>
      <div className="demo-guide-footer">{t("guideFooter")}</div>
    </div>
  );
}
