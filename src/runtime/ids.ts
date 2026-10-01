// Web Crypto is available in Node 19+ and every browser, so ids work in both.
export const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
