import { digest } from "./vault.js";

const PHRASE_POOL = "的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感";
const characters = [...new Set(PHRASE_POOL)];
export function generateRecoveryPhrase() {
  const words = new Set();
  const limit = Math.floor(256 / characters.length) * characters.length;
  const character = () => {
    let value;
    do { value = crypto.getRandomValues(new Uint8Array(1))[0]; } while (value >= limit);
    return characters[value % characters.length];
  };
  // Fresh randomness on every attempt, including duplicate retries.
  while (words.size < 8) words.add(character() + character());
  return [...words];
}
export async function recoveryHash(username, phrase) {
  const normalized = String(phrase || "").trim().replace(/\s+/g, " ");
  return digest("recovery:" + String(username || "").trim() + ":" + normalized);
}
