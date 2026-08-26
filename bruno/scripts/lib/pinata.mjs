// pools.fun and Pons both take the logo as a plain hosted URL (no reusable upload endpoint of their own),
// same situation described in o1-creator-bot/src/api/pinata.ts. Since this skill runs standalone (not
// inside Bruno's server), it needs the installing user's own Pinata JWT rather than Bruno's.
const PINATA_JWT = process.env.PINATA_JWT;

export function requirePinataJwt() {
  if (!PINATA_JWT) {
    throw new Error(
      "PINATA_JWT isn't set. pools.fun and Pons need somewhere to host the token image/metadata — get a free JWT at https://app.pinata.cloud/developers/api-keys and export it as PINATA_JWT."
    );
  }
}

async function uploadToPinata(body) {
  requirePinataJwt();
  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body,
  });
  const parsed = await res.json().catch(() => undefined);
  if (!res.ok) throw new Error(`Pinata upload failed (HTTP ${res.status}): ${JSON.stringify(parsed)}`);
  const cid = parsed?.data?.cid;
  if (!cid) throw new Error(`Pinata upload succeeded but returned no CID: ${JSON.stringify(parsed)}`);
  return `https://gateway.pinata.cloud/ipfs/${cid}`;
}

export function uploadImageToPinata(fileBuffer, contentType, filename = "logo") {
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: contentType }), filename);
  form.append("network", "public");
  return uploadToPinata(form);
}

export function uploadJsonToPinata(data, filename = "metadata.json") {
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(data)], { type: "application/json" }), filename);
  form.append("network", "public");
  return uploadToPinata(form);
}
