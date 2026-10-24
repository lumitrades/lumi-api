// Wire/protocol identifier sent in receipts and the Lumi-Kit header; unchanged when the npm package became `lumi-check`.
export const KIT_NAME = "lumi-scanner-kit";
export const KIT_VERSION = "0.1.0";
export const CONTRIB_FORMAT = "lumi-contrib/0.1";
export const RECEIPT_TYPE = "counterparty_delivery_receipt";
export const RECEIPT_VERSION = "ars-evidence/0.1";
export const DEFAULT_API = "https://api.lumitrades.io";
export const kitHeader = () => `${KIT_NAME}/${KIT_VERSION}`;
