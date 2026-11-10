import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * AES-256-GCM at rest for API keys. The key lives in a mode-600 file inside the data dir.
 * Phase 1 trade-off: good enough for a local single-user app; later phases can swap the key
 * source for Electron safeStorage / the OS keychain without changing callers.
 */
export class Secrets {
  private key: Buffer;

  constructor(keyfilePath: string) {
    if (existsSync(keyfilePath)) {
      this.key = Buffer.from(readFileSync(keyfilePath, "utf8").trim(), "base64");
    } else {
      this.key = randomBytes(32);
      writeFileSync(keyfilePath, this.key.toString("base64"), { mode: 0o600 });
      chmodSync(keyfilePath, 0o600);
    }
    if (this.key.length !== 32) throw new Error("Invalid keyfile");
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
  }

  decrypt(payload: string): string {
    const buf = Buffer.from(payload, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }
}
