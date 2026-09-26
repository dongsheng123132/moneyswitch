/**
 * SPEC-v0.5 §1 防呆: the exact same detection the server and `moneyswitch
 * sell` use (packages/tollbooth/src/secrets.ts, browser-safe subpath).
 */
export { checkPayTo, checkKeyInput, detectSecretShape, looksLikeAddress } from "@moneyswitch/tollbooth/secrets";
export type { PayToCheck, PayToErrorCode, KeyInputProblem, SecretShape } from "@moneyswitch/tollbooth/secrets";
