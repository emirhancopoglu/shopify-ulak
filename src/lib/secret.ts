import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Hesap şifrelerini diskte düz metin tutmamak için AES-256-GCM.
 * Anahtar: .env'deki APP_SECRET_KEY (64 hex karakter). Yoksa data/secret.key dosyası
 * (ilk kullanımda üretilir). İkisi de git'e girmez.
 * DİKKAT: Anahtar kaybolursa kayıtlı hesap şifreleri çözülemez; hesapları yeniden bağlamak gerekir.
 * Not: aynı makinedeki birine karşı tam koruma değildir; veritabanı dosyası
 * tek başına kopyalandığında şifrelerin okunmasını engeller.
 */
const KEY_PATH = path.join(process.cwd(), "data", "secret.key");

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.APP_SECRET_KEY?.trim();
  if (fromEnv) {
    if (!/^[0-9a-f]{64}$/i.test(fromEnv)) throw new Error("APP_SECRET_KEY 64 karakterlik hex olmalı (.env).");
    cachedKey = Buffer.from(fromEnv, "hex");
    return cachedKey;
  }
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  if (!fs.existsSync(KEY_PATH)) {
    // "wx": iki süreç aynı anda üretmeye çalışırsa ikincisi hata alır ve dosyayı okur
    try {
      fs.writeFileSync(KEY_PATH, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    } catch {
      /* başka süreç oluşturdu */
    }
  }
  cachedKey = Buffer.from(fs.readFileSync(KEY_PATH, "utf8").trim(), "hex");
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  const [v, iv, tag, data] = payload.split(":");
  if (v !== "v1") throw new Error("Bilinmeyen şifreleme biçimi");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
