/** Browser-safe paste guards shared with the agent skill package. */
export { checkPayTo, checkKeyInput, detectSecretShape, looksLikeAddress } from "@moneyswitch/skill/secrets";
export type { PayToCheck, PayToErrorCode, KeyInputProblem, SecretShape } from "@moneyswitch/skill/secrets";
