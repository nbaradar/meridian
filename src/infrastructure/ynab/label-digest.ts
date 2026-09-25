import { createHmac } from "node:crypto";

import {
  ynabLabelDigestSchema,
  type YnabLabelDigester,
} from "../../modules/ynab/account-decisions";
import {
  ynabLabelDigestEnvironment,
  type YnabLabelDigestEnvironment,
} from "../database/environment";

// Domain separation keeps these digests distinct from any other HMAC use of a
// key, even if a key were mistakenly shared.
const domain = "meridian.ynab-account-label.v1\0";

export class YnabLabelDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YnabLabelDigestError";
  }
}

/**
 * RFC 0005 keyed digest of a YNAB account name. Names are NFC-normalized so
 * visually identical names exported with different Unicode forms still match.
 * The name is never returned, stored, or included in errors.
 */
export function createYnabLabelDigester(
  environment: YnabLabelDigestEnvironment = ynabLabelDigestEnvironment(),
): YnabLabelDigester {
  const currentKeyId = environment.YNAB_LABEL_DIGEST_CURRENT_KEY_ID;
  const keys = new Map(
    Object.entries(environment.YNAB_LABEL_DIGEST_KEYRING).map(
      ([keyId, key]) => [keyId, Buffer.from(key, "base64")],
    ),
  );
  const keyIds = [
    currentKeyId,
    ...[...keys.keys()].filter((keyId) => keyId !== currentKeyId).sort(),
  ];

  return {
    digest(label, keyId = currentKeyId) {
      const key = keys.get(keyId);
      if (!key) {
        throw new YnabLabelDigestError(
          `YNAB label digest key is unavailable: ${keyId}`,
        );
      }
      if (typeof label !== "string" || label.length === 0) {
        throw new YnabLabelDigestError("YNAB account name must not be empty");
      }
      return ynabLabelDigestSchema.parse({
        digestKeyId: keyId,
        labelDigest: createHmac("sha256", key)
          .update(domain, "utf8")
          .update(label.normalize("NFC"), "utf8")
          .digest("hex"),
      });
    },
    keyIds() {
      return keyIds;
    },
  };
}
