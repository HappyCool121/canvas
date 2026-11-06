import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "../provider";
import { defaultDataDir } from "../workspace";

export type PlanTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};
export type PlanProfile = {
  id: string;
  clientId: string;
  subject: string;
  label: string;
  welcomed?: boolean;
  tokens?: PlanTokens;
  revoked?: boolean;
};
type Stored = {
  hostId: string;
  activeId?: string;
  profiles: PlanProfile[];
};

const storeError = () => new ApiError(503, "chatgpt_plan_store",
  "Canvas could not open its private ChatGPT plan store. Close other Canvas processes and check the folder permissions.");

export function openPlanStore(directory = defaultDataDir(process.platform, {}) + "-chatgpt-plan") {
  let lock: DatabaseSync | undefined;
  const file = path.join(directory, "accounts.json");
  const lockFile = path.join(directory, "lock.sqlite");
  const privatePath = (filename: string, directory = false) => {
    const stat = lstatSync(filename);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) ||
      (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077))))
      throw storeError();
  };
  function write(value: Stored) {
    const temp = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temp, file);
      // Persist the rename where directory fsync is supported.
      if (process.platform !== "win32") {
        try {
          const parent = openSync(directory, "r");
          try { fsyncSync(parent); } finally { closeSync(parent); }
        } catch { /* The atomic replacement has already committed. */ }
      }
    } catch {
      throw storeError();
    } finally {
      try { rmSync(temp, { force: true }); } catch { /* Private temporary file. */ }
    }
  }
  let value: Stored;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    try { closeSync(openSync(lockFile, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    privatePath(lockFile);
    // SQLite holds an OS file lock for the connection's lifetime, including
    // across process suspension. The OS releases it even after a crash.
    lock = new DatabaseSync(lockFile);
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    try {
      privatePath(file);
      value = JSON.parse(readFileSync(file, "utf8"));
      if (typeof value.hostId !== "string" || !Array.isArray(value.profiles)) throw storeError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      value = { hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      write(value);
    }
  } catch {
    lock?.close();
    throw storeError();
  }
  return {
    get value() { return value; },
    save(next: Stored) {
      write(next);
      value = next;
    },
    close() { lock.close(); },
  };
}
