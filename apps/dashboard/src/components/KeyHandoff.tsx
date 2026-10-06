import React, { useState } from "react";
import { useT } from "../i18n";
import { common } from "../i18n/strings/common";
import { keysStrings } from "../i18n/strings/keys";
import { skillStrings } from "../i18n/strings/skill";
import type { Handoff } from "../keyHandoff";
import type { TestPaymentOffer } from "@moneyswitch/skill";
import { restFetchCurl } from "../snippets";
import ApprovalPinNotice from "./ApprovalPinNotice";
import CopyButton from "./CopyButton";
import SecretNotice from "./SecretNotice";
import Snippet from "./Snippet";
import SkillForAi from "./SkillForAi";

/**
 * The body of the Money Keys drawer once a secret exists (a new key, or the new
 * secret of "Reset secret and copy skill"): the key once, then HOW to give it to
 * an AI. There are exactly two ways: the skill (one block of text for the AI,
 * the default) and one raw HTTP example for POST /v1/fetch. A new key also shows
 * its approval PIN once (SPEC.md §3): for a person, apart from the key and the skill.
 *
 * Mount it with `key={handoff.id}`: a new secret starts again on the skill tab.
 */
export default function KeyHandoff({
  handoff,
  skillBase,
  apiBase,
  testnet = false,
  onDone,
  initialTopTab = "skill",
}: {
  handoff: Handoff;
  /** Address written into the skill (MONEYSWITCH_PUBLIC_URL, else the page origin). */
  skillBase: string;
  apiBase: string;
  /** The test payment is on offer for this key: a testnet key on an instance that enables the receiver's testnet (see testPaymentAvailable). */
  testnet?: boolean;
  onDone: () => void;
  /** Which way is shown first. Always "skill" in the app; a render test sets "other" to check the raw HTTP example is still there. */
  initialTopTab?: "skill" | "other";
}) {
  const t = useT(keysStrings);
  const ts = useT(skillStrings);
  const tc = useT(common);
  const [topTab, setTopTab] = useState<"skill" | "other">(initialTopTab);
  const testPayment: TestPaymentOffer = { allowedHosts: handoff.allowedHosts, testnet };

  return (
    <div>
      <div className="key-once-banner">{handoff.kind === "rotated" ? ts("rotatedBanner", { name: handoff.name }) : t("createdBanner")}</div>
      <SecretNotice>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>{t("keyFieldLabel")}</label>
          <div className="key-big">{handoff.key}</div>
          <CopyButton text={handoff.key} />
        </div>
      </SecretNotice>

      {handoff.approvalPin && <ApprovalPinNotice pin={handoff.approvalPin} />}

      <div className="next-heading">{t("nextHeading")}</div>

      <div className="tabs skill-top-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={topTab === "skill"} className={`tab-btn ${topTab === "skill" ? "active" : ""}`} onClick={() => setTopTab("skill")}>
          {ts("tabSkill")}
          <span className="skill-reco">{ts("recommended")}</span>
        </button>
        <button type="button" role="tab" aria-selected={topTab === "other"} className={`tab-btn ${topTab === "other" ? "active" : ""}`} onClick={() => setTopTab("other")}>
          {ts("tabOther")}
        </button>
      </div>

      {topTab === "skill" && <SkillForAi baseUrl={skillBase} secret={handoff.key} keyName={handoff.name} testPayment={testPayment} networkMode={handoff.networkMode} />}

      {topTab === "other" && (
        <div>
          <p className="skill-other-intro">{ts("otherIntro")}</p>
          <Snippet title={ts("rawHttpTitle")} code={restFetchCurl(apiBase, handoff.key)} note={ts("rawHttpNote")} />
        </div>
      )}

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onDone}>
          {tc("done")}
        </button>
      </div>
    </div>
  );
}
