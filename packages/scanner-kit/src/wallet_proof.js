/**
 * Wallet-control proof: the wallet you pay from signs a message bound to your contributor public key, so nobody can
 * register a wallet they don't control. Signed locally; only the signature and public key leave your machine.
 */
export const walletProofMessage = (contributorPublicKeyHex, address) => {
  const a = /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address;
  return `lumi-wallet-proof:v1:${String(contributorPublicKeyHex).toLowerCase()}:${a}`;
};
/** { address, key_type, public_key?, signature } for one wallet (signer from signerFor). */
export async function walletProof(signer, contributorPublicKeyHex) {
  const address = /^0x[0-9a-fA-F]{40}$/.test(signer.address) ? signer.address.toLowerCase() : signer.address;
  const signature = await signer.sign(walletProofMessage(contributorPublicKeyHex, address));
  return { address, key_type: signer.key_type, ...(signer.public_key ? { public_key: signer.public_key } : {}), signature };
}
