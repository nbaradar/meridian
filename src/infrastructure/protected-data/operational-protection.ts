import {
  credentialProtectionEnvironment,
  identityProtectionEnvironment,
  type CredentialProtectionEnvironment,
  type IdentityProtectionEnvironment,
} from "../database/environment";
import { createCredentialEnvelopeProtector } from "./credential-envelope";
import {
  createProviderIdentityEnvelopeProtector,
  createProviderIdentityLookupKeyring,
} from "./provider-identity";
import { createXChaCha20Poly1305Keyring } from "./xchacha20-keyring";

export function createCredentialProtection(
  environment: CredentialProtectionEnvironment = credentialProtectionEnvironment(),
) {
  const credentialKeyring = createXChaCha20Poly1305Keyring({
    currentKeyId: environment.OPS_CREDENTIAL_CURRENT_KEY_ID,
    keys: environment.OPS_CREDENTIAL_KEYRING,
  });
  return createCredentialEnvelopeProtector(credentialKeyring);
}

export function createProviderIdentityProtection(
  environment: IdentityProtectionEnvironment = identityProtectionEnvironment(),
) {
  const identityKeyring = createXChaCha20Poly1305Keyring({
    currentKeyId: environment.OPS_IDENTITY_CURRENT_KEY_ID,
    keys: environment.OPS_IDENTITY_KEYRING,
  });
  const identityLookup = createProviderIdentityLookupKeyring({
    currentKeyId: environment.OPS_IDENTITY_DIGEST_CURRENT_KEY_ID,
    keys: environment.OPS_IDENTITY_DIGEST_KEYRING,
  });
  return createProviderIdentityEnvelopeProtector(
    identityKeyring,
    identityLookup,
  );
}
