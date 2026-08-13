import DHT from "@hyperswarm/dht-relay";
import Stream from "@hyperswarm/dht-relay/ws";
import sodium from "sodium-javascript";

export const cryptoScalarmultEd25519Noclamp = (
  output: Uint8Array,
  scalar: Uint8Array,
  publicKey: Uint8Array,
): void => sodium.crypto_scalarmult_ed25519_noclamp(output, scalar, publicKey);

export { Stream };
export default DHT;
